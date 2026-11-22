// The ribbon's three states (docs/adr/0098): enabled and not selected, enabled and selected,
// disabled; buttons with names, aria-pressed and disabled; no command run from a disabled item.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createServer, type ViteDevServer } from "vite";
import { initialState, reduce, type Action, type Doc, type State } from "../store.ts";
import { keyedCommands, rankCommands, type Command } from "../commands.ts";

const doc = (path: string, project: string | null): Doc => ({
  path,
  kind: "gm",
  text: "",
  saved: "",
  project,
  workspace: "/w",
  grid: { chars: 38, lines: 16, vertical: false },
});
const run = (actions: Action[], from: State = initialState()) => actions.reduce(reduce, from);

type FakeButton = {
  dataset: Record<string, string>;
  attrs: Map<string, string>;
  classes: Set<string>;
  disabled: boolean;
  title: string;
  classList: { toggle: (c: string, on: boolean) => void; contains: (c: string) => boolean };
  setAttribute: (k: string, v: string) => void;
  getAttribute: (k: string) => string | null;
  closest: (sel: string) => FakeButton | null;
};
const button = (rib: string): FakeButton => {
  const b: FakeButton = {
    dataset: { rib },
    attrs: new Map(),
    classes: new Set(),
    disabled: false,
    title: "",
    classList: { toggle: (c, on) => void (on ? b.classes.add(c) : b.classes.delete(c)), contains: (c) => b.classes.has(c) },
    setAttribute: (k, v) => void b.attrs.set(k, v),
    getAttribute: (k) => b.attrs.get(k) ?? null,
    closest: () => b,
  };
  return b;
};

const withShell = async (f: (m: Record<string, any>, server: ViteDevServer) => Promise<void>) => {
  const saved = { document: globalThis.document, window: globalThis.window, CSS: globalThis.CSS };
  const fakeWindow = Object.assign(new EventTarget(), { innerWidth: 1000, innerHeight: 800 });
  Object.assign(globalThis, {
    document: { body: {}, addEventListener: () => {}, removeEventListener: () => {}, querySelector: () => null, createElement: () => ({}) },
    window: fakeWindow,
    CSS: { escape: (v: string) => v },
  });
  const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    await f(await server.ssrLoadModule("/app/ui/shell.ts"), server);
  } finally {
    await server.close();
    Object.assign(globalThis, saved);
  }
};

/** A ctx with the real commands, a plot gate whose answer is set by the test, and the runs counted. */
const makeCtx = async (server: ViteDevServer, files: Record<string, string>, state: { s: State }) => {
  const { mountCommands } = await server.ssrLoadModule("/app/palette.ts");
  const { createPlotGate } = await server.ssrLoadModule("/app/plot/availability.ts");
  const dispatched: Action[] = [];
  const toasts: string[] = [];
  const ctx = {
    commands: [] as Command[],
    settings: [],
    editors: new Map(),
    toast: (m: string) => void toasts.push(m),
    store: { get: () => state.s, dispatch: (a: Action) => void dispatched.push(a) },
    plotGate: createPlotGate(
      { exists: async (p: string) => p in files, readText: async (p: string) => { if (!(p in files)) throw new Error("nf"); return files[p]; } },
      () => state.s,
      () => {},
    ),
  };
  mountCommands(ctx);
  ctx.commands.push({ id: "view.diff", label: "差分", when: (s: State) => s.workspace !== null, run: (c: any) => c.store.dispatch({ type: "showDiff" }) });
  return { ctx, dispatched, toasts };
};

test("ADR 0098 I1: the ribbon items are buttons named by the item, with aria-pressed", async () => {
  await withShell(async ({ ribbonHtml }) => {
    const html: string = ribbonHtml();
    const buttons = [...html.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]);
    assert.ok(buttons.length >= 11, "ten items and the settings");
    for (const b of buttons) {
      assert.match(b, /type="button"/);
      assert.match(b, /aria-label="[^"]+"/);
    }
    assert.match(html, /<button[^>]*data-rib="plot"[^>]*aria-label="プロット"/);
    assert.match(html, /<button[^>]*data-rib="files"[^>]*aria-pressed="false"/);
    assert.doesNotMatch(html, /<span class="iconbtn"/);
  });
});

test("ADR 0098 I1: closed and open file lists both use the normal color; only the open one has the selection mark", async () => {
  await withShell(async ({ renderRibbon }, server) => {
    const state = { s: { ...initialState(), sidebarPanel: "files", showSidebar: false } as State };
    const { ctx } = await makeCtx(server, {}, state);
    const files = button("files");
    const root = { querySelectorAll: () => [files] };
    renderRibbon(root, state.s, ctx);
    assert.equal(files.classes.has("on"), false);
    assert.equal(files.getAttribute("aria-pressed"), "false");
    assert.equal(files.disabled, false);
    state.s = { ...state.s, showSidebar: true };
    renderRibbon(root, state.s, ctx);
    assert.equal(files.classes.has("on"), true);
    assert.equal(files.getAttribute("aria-pressed"), "true");
    assert.equal(files.disabled, false);
  });
});

test("ADR 0098 I1: the stylesheet gives enabled items --text whether selected or not, and a mark and background only to the selected", () => {
  const css = readFileSync(new URL("../style.css", import.meta.url), "utf8");
  const rule = (sel: string) => {
    const at = css.indexOf(`${sel} {`);
    assert.ok(at >= 0, `rule ${sel}`);
    return css.slice(at, css.indexOf("}", at));
  };
  assert.match(rule(".ribbon .iconbtn"), /color: var\(--text\)/);
  const on = rule(".ribbon .iconbtn.on");
  assert.doesNotMatch(on, /color:/);
  assert.match(on, /background: var\(--sel\)/);
  assert.match(rule(".ribbon .iconbtn.on::before"), /background: var\(--text\)/);
  assert.match(rule(".ribbon .iconbtn:disabled"), /color: var\(--faint\)/);
  // a disabled item takes no hover highlight
  assert.match(css, /\.ribbon \.iconbtn:hover:not\(:disabled\) \{/);
  assert.doesNotMatch(css, /\.ribbon \.iconbtn:hover \{/);
});

test("ADR 0098 I2, I3: without a project the plot is disabled with a reason, and neither mouse nor keyboard runs it", async () => {
  await withShell(async ({ renderRibbon, wireRibbon }, server) => {
    const state = { s: initialState() };
    const { ctx, dispatched } = await makeCtx(server, {}, state);
    await ctx.plotGate.check();
    const plot = button("plot");
    renderRibbon({ querySelectorAll: () => [plot] }, state.s, ctx);
    assert.equal(plot.disabled, true);
    assert.equal(plot.getAttribute("aria-pressed"), "false");
    assert.match(plot.title, /^プロット（.+）$/);
    const handlers = new Map<string, (e: unknown) => void>();
    wireRibbon({ addEventListener: (k: string, h: (e: unknown) => void) => handlers.set(k, h) }, ctx);
    handlers.get("mouseup")!({ button: 0, target: plot });
    handlers.get("click")!({ detail: 0, target: plot });
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(dispatched, []);
  });
});

test("ADR 0098 I2, I3: a header-only plot is enabled and runs once per press; a deleted one turns disabled and does not run", async () => {
  await withShell(async ({ renderRibbon, wireRibbon }, server) => {
    const files: Record<string, string> = { "/w/p/plot.csv": "scene,file\n" };
    const state = { s: run([{ type: "open", docs: [doc("/w/p/a.gm", "/w/p")] }]) };
    const { ctx, dispatched, toasts } = await makeCtx(server, files, state);
    await ctx.plotGate.check();
    const plot = button("plot");
    const root = { querySelectorAll: () => [plot] };
    renderRibbon(root, state.s, ctx);
    assert.equal(plot.disabled, false);
    assert.equal(plot.title, "プロット");
    const handlers = new Map<string, (e: unknown) => void>();
    wireRibbon({ addEventListener: (k: string, h: (e: unknown) => void) => handlers.set(k, h) }, ctx);
    // a mouse press: mouseup runs it, the click after it (detail 1) does not run it again
    handlers.get("mouseup")!({ button: 0, target: plot });
    handlers.get("click")!({ detail: 1, target: plot });
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(dispatched, [{ type: "plot", project: "/w/p" }]);
    // the keyboard (Enter or Space on the button: a click with detail 0)
    handlers.get("click")!({ detail: 0, target: plot });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(dispatched.length, 2);
    // deleted after the check, pressed before the ribbon is drawn again: checked right before running
    delete files["/w/p/plot.csv"];
    handlers.get("mouseup")!({ button: 0, target: plot });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(dispatched.length, 2);
    assert.ok(toasts.some((t) => /plot\.csv がありません/.test(t)));
    renderRibbon(root, state.s, ctx);
    assert.equal(plot.disabled, true);
  });
});

test("ADR 0098 I4: the ribbon, the palette and the keys agree on the plot", async () => {
  await withShell(async ({ renderRibbon }, server) => {
    const files: Record<string, string> = { "/w/p/plot.csv": "scene\n" };
    const state = { s: run([{ type: "open", docs: [doc("/w/q/a.gm", "/w/q")] }]) };
    const { ctx } = await makeCtx(server, files, state);
    const agree = () => {
      const plot = button("plot");
      renderRibbon({ querySelectorAll: () => [plot] }, state.s, ctx);
      const palette = rankCommands(ctx.commands, state.s, "", []).some((c) => c.id === "view.plot");
      const keys = keyedCommands(ctx.commands, state.s, false).some((c) => c.id === "view.plot");
      assert.equal(palette, !plot.disabled);
      assert.equal(keys, !plot.disabled);
      return !plot.disabled;
    };
    await ctx.plotGate.check();
    assert.equal(agree(), false);
    state.s = run([{ type: "open", docs: [doc("/w/p/a.gm", "/w/p")] }]);
    // switched but not checked yet: checking, disabled everywhere
    assert.equal(agree(), false);
    await ctx.plotGate.check();
    assert.equal(agree(), true);
  });
});

test("ADR 0098 I3: the diff item follows view.diff's check, and a disabled one does not run", async () => {
  await withShell(async ({ renderRibbon, wireRibbon }, server) => {
    const state = { s: initialState() };
    const { ctx, dispatched } = await makeCtx(server, {}, state);
    const diff = button("diff");
    renderRibbon({ querySelectorAll: () => [diff] }, state.s, ctx);
    assert.equal(diff.disabled, true);
    const handlers = new Map<string, (e: unknown) => void>();
    wireRibbon({ addEventListener: (k: string, h: (e: unknown) => void) => handlers.set(k, h) }, ctx);
    handlers.get("mouseup")!({ button: 0, target: diff });
    handlers.get("click")!({ detail: 0, target: diff });
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(dispatched, []);
    state.s = { ...state.s, workspace: "/w" };
    renderRibbon({ querySelectorAll: () => [diff] }, state.s, ctx);
    assert.equal(diff.disabled, false);
  });
});
