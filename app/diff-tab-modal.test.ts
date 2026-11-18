// The modal flag of the dialogs before applying (docs/adr/0088 I10): while it is up, the keys run
// no command and the command palette does not open.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

const cmdW = () => ({ key: "w", code: "KeyW", ctrlKey: false, metaKey: true, altKey: false, shiftKey: false, isComposing: false, keyCode: 0 });

test("ADR 0088 I10: ⌘W while the modal flag is up closes no tab; after the dialog closes, it does", async () => {
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { platform: "MacIntel" } });
  const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const { dispatchKey } = await server.ssrLoadModule("/app/keybind.ts");
    const { createStore } = await server.ssrLoadModule("/app/store.ts");
    const store = createStore();
    const closed: number[] = [];
    const ctx = {
      commands: [{ id: "file.closeTab", keys: ["Mod-w"], scope: "global", when: () => true, run: () => closed.push(1) }],
      config: { keyBindings: {}, leaderKey: "Mod-;", keySequenceTimeout: 1000 },
      store,
      editors: new Map(),
      refresh: () => {},
    };
    store.dispatch({ type: "modal", on: true });
    assert.equal(dispatchKey(ctx, cmdW(), false), false);
    assert.deepEqual(closed, []);
    store.dispatch({ type: "modal", on: false });
    assert.equal(dispatchKey(ctx, cmdW(), false), true);
    assert.deepEqual(closed, [1]);
  } finally {
    await server.close();
  }
});

test("ADR 0088 I10: the command palette does not open while the modal flag is up", async () => {
  const oldDocument = globalThis.document;
  let appended = 0;
  Object.assign(globalThis, {
    document: { querySelector: () => null, activeElement: null, createElement: () => { throw new Error("the palette was built"); }, body: { append: () => void appended++ } },
  });
  const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const { openCommandPalette } = await server.ssrLoadModule("/app/palette.ts");
    const { createStore } = await server.ssrLoadModule("/app/store.ts");
    const store = createStore();
    store.dispatch({ type: "modal", on: true });
    openCommandPalette({ store, commands: [] }, ">");
    assert.equal(appended, 0);
  } finally {
    Object.assign(globalThis, { document: oldDocument });
    await server.close();
  }
});
