import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import type { EditorOptions } from "./editor.ts";
import type { Core, Tx } from "./core.ts";

test("ADR 0091 I2, I3, I4: refresh after editing, undo and replacing a document with the same selection", async () => {
  type ViewOptions = { core: Core; onUpdate: (tx: Tx | null) => void };
  const server = await createServer({
    optimizeDeps: { noDiscovery: true },
    configFile: false,
    server: { middlewareMode: true, ws: false },
    appType: "custom",
    plugins: [{
      name: "selection-highlight-test-view",
      enforce: "pre",
      resolveId(source, importer) {
        if (importer?.endsWith("/ed/editor.ts") && source === "./view.ts") return "virtual:selection-highlight-test-view";
      },
      load(id) {
        if (id === "virtual:selection-highlight-test-view") return `export const createView = (options) => {
          globalThis.selectionHighlightTestView = options;
          const stop = options.core.listen((tx) => {
            const { core } = options;
            const before = core.state();
            options.onUpdate(tx);
            const after = core.state();
            if (after.doc !== before.doc || after.sel !== before.sel ||
                after.layers.get("search") !== before.layers.get("search") ||
                after.layers.get("diag") !== before.layers.get("diag")) {
              throw new Error("Selection highlighting changed editor state outside its layer");
            }
          });
          return {
            content: { addEventListener() {} }, setMarks() {}, setBreaks() {},
            setDiagLines() {}, layersChanged() {}, syncSelection() {}, revealCaret() {}, destroy: stop,
          };
        };`;
      },
    }],
  });
  const globals = globalThis as typeof globalThis & { selectionHighlightTestView?: ViewOptions };
  const previousWindow = globals.window;
  Object.assign(globals, { window: globals });
  try {
    const { createEditor } = await server.ssrLoadModule("/app/ed/editor.ts");
    const editor = createEditor({
      parent: {} as HTMLElement, kind: "txt", text: "猫 猫 _", chars: 40, vertical: false,
      grid: { chars: 40, lines: 20, vertical: false }, invisibles: false, style: "prose",
      base: async () => false, onChange() {}, onSave() {},
    } satisfies EditorOptions);
    try {
      const { core, onUpdate } = globals.selectionHighlightTestView!;
      const selection = { anchor: 0, head: 1 };
      const search = [{ from: 0, to: 1, cls: "ed-match" }];
      const diagnostics = [{ from: 0, to: 1, cls: "diag-warning" }];
      core.setLayer("search", search);
      core.setLayer("diag", diagnostics);
      core.select(selection);
      onUpdate(null);
      const check = (offset: number | null, text: string) => {
        assert.deepEqual(core.layer("selmatch"), offset === null ? [] : [{ from: offset, to: offset + 1, cls: "ed-selmatch" }]);
        assert.equal(core.text(), text);
        assert.deepEqual(core.sel(), selection);
      };
      check(2, "猫 猫 _");
      assert.deepEqual(core.layer("search"), search);
      assert.deepEqual(core.layer("diag"), diagnostics);
      core.apply([{ from: 4, to: 5, insert: "猫" }], "edit");
      assert.deepEqual(core.layer("selmatch").map((m) => m.from), [2, 4]);
      assert.equal(core.undo(), true);
      core.apply([{ from: 2, to: 3, insert: "犬" }], "edit");
      check(null, "猫 犬 _");
      assert.equal(core.undo(), true);
      check(2, "猫 猫 _");
      assert.equal(core.redo(), true);
      core.apply([{ from: 0, to: core.doc().length, insert: "猫 犬 猫" }], "set", selection);
      check(4, "猫 犬 猫");
      core.select({ anchor: 0, head: 0 });
      onUpdate(null);
      assert.deepEqual(core.layer("selmatch"), []);
    } finally {
      editor.destroy();
    }
  } finally {
    await server.close();
    delete globals.selectionHighlightTestView;
    Object.assign(globals, { window: previousWindow });
  }
});
