import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";
import type { Ctx } from "../ctx.ts";

test("ADR 0070 invariants 1-3 and ADR 0066 invariants 1-2: tree handlers act on the clicked row", async () => {
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
      save: async () => {}, refresh: () => {}, toast: () => {},
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

    let manifest = 'chapters = ["a.gm"]\n';
    let exported: { path: string; live: string | null }[] = [];
    api.listTree = async () => [{ path: "/w/book", name: "book", dir: true, children: [
      { path: "/w/book/manifest.toml", name: "manifest.toml", dir: false, children: [] },
      { path: "/w/book/a.gm", name: "a.gm", dir: false, children: [] },
      { path: "/w/book/b.gm", name: "b.gm", dir: false, children: [] },
    ] }];
    api.readText = async (path: string) => path.endsWith("manifest.toml") ? manifest : "# Sheet\n";
    api.writeText = async (path: string, text: string) => { if (path.endsWith("manifest.toml")) manifest = text; };
    api.exportChapters = async (parts: typeof exported) => { exported = parts; return true; };
    (state as { selected: string[]; expanded: string[] }).selected = ["/w/book/b.gm", "/w/book/a.gm"];
    (state as { expanded: string[] }).expanded = ["/w/book"];
    await (await server.ssrLoadModule("/app/ui/tree.ts")).reloadTree(ctx);
    const menuFor = (path: string) => treeMenus.flatMap((f: (p: string, d: boolean, c: Ctx) => { label?: string; run?: () => void }[]) => f(path, false, ctx));
    const exportItem = menuFor("/w/book/a.gm").find((item: { label?: string }) => item.label === "選択した原稿を書き出す");
    assert.ok(exportItem?.run, "ADR 0066 invariant 2: selected gm files have an export action");
    exportItem.run();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(exported.map((part) => part.path), ["/w/book/a.gm", "/w/book/b.gm"]);
    assert.deepEqual((state as { selected: string[] }).selected, ["/w/book/b.gm", "/w/book/a.gm"]);
    (ctx.store as unknown as { dispatch: (action: { type: string; paths?: string[] }) => void }).dispatch = (action) => {
      if (action.type === "select") (state as { selected: string[] }).selected = action.paths ?? [];
    };
    listeners.get("contextmenu")?.({ target: { closest: () => Object.assign(element(), { dataset: { file: "/w/book/b.gm" } }) }, preventDefault: () => {} });
    assert.deepEqual((state as { selected: string[] }).selected, ["/w/book/b.gm", "/w/book/a.gm"]);
    listeners.get("contextmenu")?.({ target: { closest: () => Object.assign(element(), { dataset: { file: "/w/book/manifest.toml" } }) }, preventDefault: () => {} });
    assert.deepEqual((state as { selected: string[] }).selected, ["/w/book/manifest.toml"]);
    const removeItem = menuFor("/w/book/a.gm").find((item: { label?: string }) => item.label === "chapters から削除");
    assert.ok(removeItem?.run, "ADR 0066 invariant 1: the clicked registered chapter can be removed");
    removeItem.run();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(manifest, "chapters = []\n");
  } finally {
    await server.close();
    Object.assign(globalThis, { document: previousDocument });
  }
});
