import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import type { Editor, EditorOptions } from "./editor.ts";
import type { Input } from "./control.ts";
import type { Core, Tx } from "./core.ts";

type ViewOptions = { core: Core; onUpdate: (tx: Tx | null) => void; input: Input };

const withEditor = async (check: (editor: Editor, view: ViewOptions) => void) => {
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
        if (id === "virtual:selection-highlight-test-view") return `
        import { createInput } from "/app/ed/control.ts";
        export const createView = (options) => {
          const input = createInput(options.core);
          globalThis.selectionHighlightTestView = { ...options, input };
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
            setDiagLines() {}, layersChanged() {}, syncSelection() {}, revealCaret() {},
            whenIdle: input.ime.whenIdle, destroy: stop,
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
      check(editor, globals.selectionHighlightTestView!);
    } finally {
      editor.destroy();
    }
  } finally {
    await server.close();
    delete globals.selectionHighlightTestView;
    Object.assign(globals, { window: previousWindow });
  }
};

test("ADR 0091 I2, I3, I4: refresh after editing, undo and replacing a document with the same selection", () =>
  withEditor((_editor, { core, onUpdate }) => {
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
  }),
);

for (const request of ["setText", "fromOutside"] as const) {
  test(`ADR 0091 I3, I4: ${request} during composition applies after the IME transaction`, () =>
    withEditor((editor, { core, onUpdate, input }) => {
      const firstCharacter = { anchor: 0, head: 1 };
      const highlight = (from: number) => [{ from, to: from + 1, cls: "ed-selmatch" }];
      core.select(firstCharacter);
      onUpdate(null);
      assert.deepEqual(core.layer("selmatch"), highlight(2));

      input.compositionStart();
      editor[request]!("犬 _ 犬");
      assert.equal(core.text(), "猫 猫 _");
      assert.deepEqual(core.layer("selmatch"), highlight(2));
      input.compositionEnd("霧", () => "霧 猫 _");

      assert.equal(core.text(), "犬 _ 犬");
      assert.deepEqual(core.layer("selmatch"), []);
      core.select(firstCharacter);
      onUpdate(null);
      assert.deepEqual(core.layer("selmatch"), highlight(4));

      assert.equal(core.undo(), true);
      assert.equal(core.text(), "霧 猫 _");
      assert.equal(core.undo(), true);
      assert.equal(core.text(), "猫 猫 _");
      assert.deepEqual(core.layer("selmatch"), highlight(2));
    }),
  );
}
