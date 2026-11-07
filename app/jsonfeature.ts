// JSON, JSONC, JSON5 and JSON Lines in the editor (docs/adr/0021): the grammar
// checked as diagnostics while writing, and formatting with ⌥⇧F, the toolbar
// menu and ⌘S (following the "⌘S で整形する" setting).
import type { Ctx } from "./ctx.ts";
import type { EditorPlugin, TextEditor } from "./ed/editor.ts";
import { diffText } from "./ed/ime.ts";
import { checkJson, formatJson, formatThenSave, isJsonKind, type Flavor } from "./ed/json.ts";
import { focused, type Doc } from "./store.ts";

const CHECK_DELAY = 300;
const editors = new Map<string, { t: TextEditor; flavor: Flavor }>();

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
  const path = doc.path;
  let t: TextEditor | null = null;
  return {
    attach: (te) => {
      t = te;
      editors.set(path, { t: te, flavor });
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
        if (editors.get(path)?.t === te) editors.delete(path);
      };
    },
    keys: [
      {
        key: "Mod-s",
        run: () => {
          if (!t) return false;
          const te = t;
          void formatThenSave({ formatOnSave: ctx.config.formatOnSave, format: () => formatIn(te, flavor), save: () => ctx.save([path], { explicit: true }), notify: ctx.toast });
          return true;
        },
      },
      { key: "Shift-Alt-f", run: () => (t ? (ctx.toast(notice(formatIn(t, flavor))), true) : false) },
    ],
  };
};

export const mountJson = (ctx: Ctx) => {
  ctx.editorPlugins.push(pluginFor);
  ctx.commands.push({
    label: "整形（⌥⇧F）",
    icon: "wand-sparkles",
    when: (s) => {
      const d = focused(s);
      return !!d && isJsonKind(d.kind);
    },
    run: (c) => {
      const d = focused(c.store.get());
      const e = d && editors.get(d.path);
      if (e) c.toast(notice(formatIn(e.t, e.flavor)));
    },
  });
  // the list of the editor's diagnostics (the status bar's LSP item is for golem lsp only)
  ctx.commands.push({
    label: "診断の一覧",
    icon: "list",
    when: (s) => {
      const d = focused(s);
      return !!d && isJsonKind(d.kind);
    },
    run: (c) => {
      const d = focused(c.store.get());
      if (d) editors.get(d.path)?.t.openDiagnostics();
    },
  });
};
