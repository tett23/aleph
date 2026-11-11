// JSON, JSONC, JSON5 and JSON Lines in the editor (docs/adr/0021): the grammar
// checked as diagnostics while writing, and formatting with ⌥⇧F, the toolbar
// menu and ⌘S (following the "⌘S で整形する" setting).
import type { Ctx } from "./ctx.ts";
import type { EditorPlugin, TextEditor } from "./ed/editor.ts";
import { diffText } from "./ed/ime.ts";
import { checkJson, formatJson, formatThenSave, isJsonKind, type Flavor } from "./ed/json.ts";
import type { Doc } from "./store.ts";

const CHECK_DELAY = 300;

/** Formats a sheet as one undoable change; "error" when the document has a grammar error. */
const formatIn = (t: TextEditor, flavor: Flavor): "changed" | "same" | "error" => {
  const before = t.core.text();
  const after = formatJson(before, flavor);
  if (after === null) return "error";
  const d = diffText(before, after);
  if (!d) return "same";
  t.apply([d], "format");
  return "changed";
};

const notice = (r: "changed" | "same" | "error") => (r === "error" ? "JSON に誤りがあるため整形しません" : r === "changed" ? "整形しました" : "変更はありません");

const pluginFor = (doc: Doc, ctx: Ctx): EditorPlugin | null => {
  if (!isJsonKind(doc.kind)) return null;
  const flavor = doc.kind;
  let t: TextEditor | null = null;
  return {
    attach: (te) => {
      t = te;
      let timer = 0;
      const check = () => te.setDiagnostics(checkJson(te.core.text(), flavor));
      check();
      const off = te.core.listen(() => {
        clearTimeout(timer);
        timer = window.setTimeout(check, CHECK_DELAY);
      });
      return () => {
        clearTimeout(timer);
        off();
      };
    },
    keys: [
      {
        id: "file.save",
        key: "Mod-s",
        run: () => {
          if (!t) return false;
          const te = t;
          void formatThenSave({ formatOnSave: ctx.config.formatOnSave, format: () => formatIn(te, flavor), save: () => ctx.save([doc.path], { explicit: true }), notify: ctx.toast });
          return true;
        },
      },
      { id: "editor.format", key: "Shift-Alt-f", run: () => (t ? (ctx.toast(notice(formatIn(t, flavor))), true) : false) },
    ],
  };
};

export const mountJson = (ctx: Ctx) => {
  ctx.editorPlugins.push(pluginFor);

};
