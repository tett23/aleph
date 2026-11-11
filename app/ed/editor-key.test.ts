import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";

test("ADR 0073 invariants 1, 3 and 5: editor key path dismisses once and then moves to the logical line end", async () => {
  let keyHandler: (event: KeyboardEvent) => boolean = () => false;
  let composing = false;
  let popupOpen = false;
  let delayedResponse: Promise<unknown> | null = null;
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
    plugins: [{ name: "editor-test-view", enforce: "pre", resolveId(source, importer) {
      if (importer?.endsWith("/ed/editor.ts") && source === "./view.ts") return "virtual:editor-test-view";
      if (importer?.endsWith("/ed/editor.ts") && source === "./panels.ts") return "virtual:editor-test-panels";
    }, load(id) {
      if (id === "virtual:editor-test-view") return `export const createView = (options) => {
        globalThis.__editorTestKey = options.onKey;
        return { content: { addEventListener() {} }, root: {}, composing: () => globalThis.__editorTestComposing,
          coordsAt: () => ({ left: 0, right: 0, top: 0, bottom: 0 }), isVertical: () => false,
          setMarks() {}, setBreaks() {}, syncSelection() {}, revealCaret() {}, focus() {},
          whenIdle(f) { f(); }, destroy() {}, setChars() {}, setInvisibles() {}, setVertical() {},
          setDiagLines() {}, setLayer() {}, layersChanged() {}, toggleClass() {} };
      };`;
      if (id === "virtual:editor-test-panels") return `export const createCompletionList = () => {
        globalThis.__editorTestPopup = true;
        return { key: () => false, close: () => { globalThis.__editorTestPopup = false; } };
      };
      export const panelHost = () => ({});
      export const createSearchPanel = () => ({ close() {} });
      export const popup = () => ({ remove() {} });`;
    } }],
  });
  const previousWindow = globalThis.window;
  Object.assign(globalThis, { window: globalThis, __editorTestComposing: false, __editorTestPopup: false });
  try {
    const { createEditor } = await server.ssrLoadModule("/app/ed/editor.ts");
    const { dispatchKey } = await server.ssrLoadModule("/app/keybind.ts");
    const { mountCommands } = await server.ssrLoadModule("/app/palette.ts");
    const ctx = {
      commands: [], settings: [],
      config: { keyBindings: {} as Record<string, string[]>, leaderKey: "Mod-k", keySequenceTimeout: 1000 },
      store: { get: () => ({ open: [{ path: "/w/a.gm" }], focus: 0 }) },
      editors: new Map<string, unknown>(), refresh: () => {},
    };
    mountCommands(ctx);
    const editor = createEditor({
      parent: {}, kind: "gm", text: "abc\nlast", grid: { chars: 40, lines: 20, vertical: false }, chars: 40,
      invisibles: false, vertical: false, style: "prose", base: async () => false,
      onChange: () => {}, onSave: () => {}, keys: (event: KeyboardEvent) => dispatchKey(ctx, event, true), plugins: [{ complete: async () => (await delayedResponse ?? { from: 0, items: [{ label: "abc", apply: "abc" }] }) }],
    });
    keyHandler = (globalThis as unknown as { __editorTestKey: typeof keyHandler }).__editorTestKey;
    ctx.editors.set("/w/a.gm", editor);
    const press = (key: string, code: string, ctrlKey = false) => keyHandler({ key, code, ctrlKey, metaKey: false, altKey: false, shiftKey: false, isComposing: false } as KeyboardEvent);
    editor.edit!.core.select({ anchor: 1, head: 1 });
    assert.equal(editor.edit!.command("editor.complete"), true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    popupOpen = (globalThis as unknown as { __editorTestPopup: boolean }).__editorTestPopup;
    assert.equal(popupOpen, true);
    assert.equal(editor.edit!.completionVisible(), true);
    let resolveLate!: (response: unknown) => void;
    delayedResponse = new Promise((resolve) => { resolveLate = resolve; });
    assert.equal(editor.edit!.command("editor.complete"), true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(press("e", "KeyE", true), true);
    assert.equal(editor.edit!.core.sel().head, 1);
    assert.equal(editor.edit!.completionVisible(), false);
    assert.equal(press("e", "KeyE", true), true);
    assert.equal(editor.edit!.core.sel().head, 3);
    assert.equal(editor.text(), "abc\nlast");
    editor.setVertical(true);
    editor.edit!.core.select({ anchor: 8, head: 1 });
    assert.equal(press("e", "KeyE", true), true);
    assert.deepEqual(editor.edit!.core.sel(), { anchor: 3, head: 3 }, "ADR 0073 invariant 5: the moving end controls a reversed selection in vertical mode");
    assert.equal(press("Escape", "Escape"), false);
    resolveLate({ from: 0, items: [{ label: "abc", apply: "abc" }] });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(editor.edit!.completionVisible(), false, "ADR 0073 invariant 4: the response started before dismissal stays hidden");
    delayedResponse = null;
    assert.equal(editor.edit!.command("editor.complete"), true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    ctx.config.keyBindings["editor.dismissCompletion"] = ["Ctrl-e"];
    assert.equal(press("Escape", "Escape"), false);
    assert.equal(editor.edit!.completionVisible(), true, "ADR 0073 invariant 2: removing Esc leaves it unbound");
    delete ctx.config.keyBindings["editor.dismissCompletion"];
    assert.equal(press("Escape", "Escape"), true);
    assert.equal(editor.edit!.completionVisible(), false);
    assert.equal(editor.edit!.command("editor.complete"), true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(editor.edit!.completionVisible(), true);
    assert.equal(editor.edit!.command("editor.complete"), true);
    assert.equal(press("e", "KeyE", true), true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(editor.edit!.completionVisible(), false, "ADR 0073 invariant 4: the request reserved before dismissal stays hidden");
    editor.edit!.core.select({ anchor: 2, head: 6 });
    assert.equal(press("e", "KeyE", true), true);
    assert.deepEqual(editor.edit!.core.sel(), { anchor: 8, head: 8 });
    assert.equal(press("e", "KeyE", true), true);
    assert.equal(editor.edit!.core.sel().head, 8);
    composing = true;
    (globalThis as unknown as { __editorTestComposing: boolean }).__editorTestComposing = composing;
    assert.equal(editor.edit!.command("editor.moveToLineEnd"), false);
    editor.destroy();
  } finally {
    await server.close();
    delete (globalThis as { __editorTestKey?: unknown }).__editorTestKey;
    delete (globalThis as { __editorTestComposing?: unknown }).__editorTestComposing;
    delete (globalThis as { __editorTestPopup?: unknown }).__editorTestPopup;
    Object.assign(globalThis, { window: previousWindow });
  }
});
