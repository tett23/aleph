import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";
import type { Ctx } from "../ctx.ts";

test("ADR 0070 invariants 1-3: tree handlers protect root files and rename only the activated row", async () => {
  const listeners = new Map<string, (event: unknown) => void>();
  let answer = "";
  let menuElement: FakeElement | null = null;

  type FakeElement = {
    dataset: Record<string, string>;
    children: FakeElement[];
    handlers: Map<string, (event: unknown) => void>;
    content: { firstElementChild: FakeElement };
    value: string;
    innerHTML: string;
    onmouseup?: (event: { button: number }) => void;
    onclick?: (event: unknown) => void;
    ondblclick?: (event: unknown) => Promise<void>;
    addEventListener: (name: string, handler: (event: unknown) => void) => void;
    append: (child: FakeElement) => void;
    querySelector: (selector: string) => FakeElement | null;
    getBoundingClientRect: () => { bottom: number; left: number };
    focus: () => void;
    select: () => void;
    remove: () => void;
    contains: () => boolean;
  };
  const element = (): FakeElement => {
    const el = {
      dataset: {}, children: [], handlers: new Map(), content: null, value: "", innerHTML: "",
      addEventListener(name: string, handler: (event: unknown) => void) { el.handlers.set(name, handler); },
      append(child: FakeElement) {
        el.children.push(child);
        if (child.innerHTML.includes('class="menu"')) menuElement = child;
        if (child.innerHTML.includes('class="dim"')) {
          queueMicrotask(() => child.handlers.get("click")?.({ target: { closest: (selector: string) => selector === "[data-ok]" } }));
        }
      },
      querySelector(selector: string) { return selector === "input" ? Object.assign(element(), { value: answer }) : null; },
      getBoundingClientRect() { return { bottom: 0, left: 0 }; },
      focus() {}, select() {}, remove() {}, contains() { return false; },
    } as unknown as FakeElement;
    el.content = { firstElementChild: el };
    return el;
  };

  const fakeDocument = {
    body: element(),
    createElement: () => element(),
    addEventListener: (name: string, handler: (event: unknown) => void) => listeners.set(name, handler),
    removeEventListener: () => {},
    querySelectorAll: () => [],
  };
  const previousDocument = globalThis.document;
  Object.assign(globalThis, { document: fakeDocument, innerWidth: 1000 });
  const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const { api } = await server.ssrLoadModule("/app/api.ts");
    const { mountTree, treeMenus } = await server.ssrLoadModule("/app/ui/tree.ts");
    const renamed: [string, string][] = [];
    api.listTree = async () => [{ path: "/w/book", name: "book", dir: true, children: [{ path: "/w/book/manifest.toml", name: "manifest.toml", dir: false, children: [] }] }];
    api.readText = async () => "";
    api.exists = async () => false;
    api.rename = async (from: string, to: string) => { renamed.push([from, to]); };
    const state = { workspace: "/w", workspaces: ["/w"], expanded: [], panes: [], open: [], selected: [], plot: null };
    const ctx = {
      left: {}, settings: [], beforeRename: [], onRename: [], projects: ["/w/book"], decor: [], titles: new Map(), editors: new Map(),
      store: { get: () => state, dispatch: () => {} },
      save: async () => {}, refresh: () => {},
    } as unknown as Ctx;
    mountTree(ctx);
    const tree = element();
    await ctx.left.files!.render(tree as unknown as HTMLElement, ctx);
    const eventFor = (path: string, dir = false) => ({ target: { closest: () => Object.assign(element(), { dataset: dir ? { dir: path } : { file: path } }) } });

    for (const name of ["plot.csv", "manifest.toml", "style.toml"]) {
      const path = `/w/book/${name}`;
      await tree.ondblclick!(eventFor(path));
      menuElement = null;
      listeners.get("contextmenu")?.({
        target: { closest: (selector: string) => name === "plot.csv" && selector.includes(":not([data-plot])") ? null : Object.assign(element(), { dataset: { file: path } }) },
        preventDefault: () => {},
      });
      assert.equal((menuElement as FakeElement | null)?.children.some((child: FakeElement) => child.innerHTML.includes("名前を変える")) ?? false, false);
    }
    assert.deepEqual(renamed, []);
    assert.equal(fakeDocument.body.children.some((child) => child.innerHTML.includes('class="dim"')), false);

    answer = "new.gm";
    await tree.ondblclick!(eventFor("/w/book/chapters/old.gm"));
    assert.deepEqual(renamed, [["/w/book/chapters/old.gm", "/w/book/chapters/new.gm"]]);
    assert.equal(treeMenus.flatMap((f: (p: string, d: boolean, c: Ctx) => unknown[]) => f("/w/book/chapters/old.gm", false, ctx)).some((x: { label?: string }) => x.label === "名前を変える"), true);

    answer = "renamed";
    listeners.get("contextmenu")?.({ target: { closest: () => Object.assign(element(), { dataset: { dir: "/w/book/chapters" } }) }, preventDefault: () => {} });
    const renameItem = (menuElement as FakeElement | null)?.children.find((child: FakeElement) => child.innerHTML.includes("名前を変える"));
    assert.ok(renameItem);
    renameItem.onmouseup?.({ button: 0 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(renamed[1], ["/w/book/chapters", "/w/book/renamed"]);

    await tree.ondblclick!(eventFor("/w/book/chapters", true));
    assert.equal(renamed.length, 2);
  } finally {
    await server.close();
    Object.assign(globalThis, { document: previousDocument });
  }
});

test("ADR 0067 invariant 2: display filters do not change the base tree used by search and trash", async () => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const { api } = await server.ssrLoadModule("/app/api.ts");
    const { reloadTree, treeEntries } = await server.ssrLoadModule("/app/ui/tree.ts");
    const sheet = (path: string) => ({ path, name: path.split("/").at(-1)!, dir: false, children: [] });
    api.listTree = async (_root: string, options?: { showHidden: boolean; showIgnored: boolean }) =>
      options?.showHidden ? [sheet("/w/.draft.gm")] : options?.showIgnored === false ? [] : [sheet("/w/ignored.gm")];
    api.readText = async () => "# Heading\n";
    const ctx = {
      config: { showHiddenFiles: true, showGitignoredFiles: false },
      store: { get: () => ({ workspace: "/w", workspaces: ["/w"] }) },
      titles: new Map<string, string>(), projects: [],
    } as unknown as Ctx;
    await reloadTree(ctx);
    assert.deepEqual(treeEntries().map((entry: { path: string }) => entry.path), ["/w/ignored.gm"]);
    assert.equal(ctx.titles.get("/w/.draft.gm"), "Heading");
    assert.equal(ctx.titles.get("/w/ignored.gm"), "Heading");
  } finally {
    await server.close();
  }
});

test("ADR 0067 invariant 2: trash identifies a visible hidden folder and all its descendants", async () => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const { api } = await server.ssrLoadModule("/app/api.ts");
    const { entryForTrash, filesUnder } = await server.ssrLoadModule("/app/trashpanel.ts");
    api.listTree = async (root: string) => root === "/w"
      ? [{ path: "/w/.draft", name: ".draft", dir: true, children: [] }]
      : [{ path: "/w/.draft/.hidden.gm", name: ".hidden.gm", dir: false, children: [] }, { path: "/w/.draft/ignored.gm", name: "ignored.gm", dir: false, children: [] }];
    assert.equal((await entryForTrash("/w/.draft"))?.dir, true);
    assert.deepEqual(await filesUnder("/w/.draft"), ["/w/.draft/.hidden.gm", "/w/.draft/ignored.gm"]);
  } finally {
    await server.close();
  }
});
