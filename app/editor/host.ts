// The editors of the open sheets (docs/adr/0006, docs/adr/0019): how each is made,
// the status bar's grid and caret, and the editor settings. The panes and tabs
// that hold them are in panes.ts (docs/adr/0024).
import { addCommands } from "../commands.ts";
import type { Ctx } from "../ctx.ts";
import { createEditor, type Editor } from "../ed/editor.ts";
import { dispatchKey } from "../keybind.ts";
import { separatorOf } from "../separator.ts";
import { markdownHook } from "../preview/render.ts";
import { allDocs, focused, type Doc } from "../store.ts";
import { canVertical, PROSE } from "../toolbar.ts";
import { mountPanes } from "./panes.ts";
import { item, toggle } from "../ui/settings.ts";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

/** The characters per line for a sheet: the setting, or style.toml's; code is wide. */
export const charsOf = (doc: Doc, override: number | null) => (["gm", "md", "txt"].includes(doc.kind) ? (override ?? doc.grid.chars) : 110);

const editorFor = (el: HTMLElement, doc: Doc, ctx: Ctx, _index: number, scroller: HTMLElement | undefined): Editor => {
  const kindView = ctx.kindViews[doc.kind];
  if (kindView) return kindView(el, doc, ctx);
  let self: Editor | null = null;
  const made = createEditor({
    parent: el,
    kind: doc.kind,
    text: doc.text,
    grid: doc.grid,
    chars: charsOf(doc, ctx.config.charsOverride),
    invisibles: ctx.config.showInvisibles,
    vertical: ctx.store.get().vertical && canVertical(doc.kind),
    style: PROSE.includes(doc.kind) ? "prose" : "code",
    scroller,
    base: () => ctx.baseText(doc),
    onChange: (text) => ctx.store.dispatch({ type: "edit", path: doc.path, text }),
    onSave: () => void ctx.save([doc.path], { explicit: true }),
    // an editor in another tab or pane takes the selection there
    onFocus: () => {
      // by the editor itself: a rename changes the sheet's path
      const path = [...ctx.editors.entries()].find(([, e]) => e === self)?.[0];
      if (path) ctx.store.dispatch({ type: "focusDoc", path });
    },
    onCaret: () => ctx.refresh(["status"]),
    onDiagnostics: () => ctx.refresh(["problems", "status"]),
    plugins: ctx.editorPlugins.flatMap((f) => f(doc, ctx) ?? []),
    keys: (e) => dispatchKey(ctx, e, true),
    separator: () => separatorOf(doc.project, doc.path, ctx.editors.get(doc.path)?.text() ?? doc.text),
  });
  self = made;
  return made;
};

export const mountEditors = (ctx: Ctx) => {
  mountPanes(ctx, (el, doc, index, scroller) => editorFor(el, doc, ctx, index, scroller));

  // the grid and the caret in the status bar
  ctx.status.push((s) => {
    const d = focused(s);
    if (!d || !d.project) return "";
    const chars = charsOf(d, ctx.config.charsOverride);
    return `<span>${chars} 字 × ${d.grid.lines} 行${ctx.config.charsOverride ? "（上書き）" : ""}${d.grid.vertical ? " · 縦組み" : ""}</span>`;
  });
  ctx.status.push((s) => {
    const core = (focused(s) && ctx.editors.get(focused(s)!.path))?.edit?.core;
    if (!core) return "";
    const head = core.sel().head;
    const line = core.doc().lineAt(head);
    return `<span>行 ${line.number}, 列 ${head - line.from + 1}</span>`;
  });

  // the screen that records input events for the editor's tests (docs/adr/0019)
  addCommands(ctx.commands, {
    id: "dev.recordIme",
    menu: true,
    label: "IME のイベントを記録（開発用）",
    icon: "type",
    when: () => true,
    run: () => void new WebviewWindow(`imelog-${Date.now()}`, { url: "index.html?view=imelog", title: "IME の記録", width: 900, height: 760 }),
  });

  ctx.settings.push({
    id: "editor",
    label: "エディタ",
    group: "オプション",
    render: (c) =>
      item("1 行の字数", "空なら style.toml の [page.grid] characters", `<input class="field num" type="number" min="5" max="200" data-num="charsOverride" value="${c.config.charsOverride ?? ""}" placeholder="—">`) +
      item("本文の文字サイズ", "gm、md、txt のエディタ（縦書きも）と、本文のプレビュー（既定 16 px）", `<input class="field num" type="number" min="10" max="32" data-num="fontSize" value="${c.config.fontSize}"> px`) +
      item("コードの文字サイズ", "toml、emet などのエディタ（既定 13 px）", `<input class="field num" type="number" min="9" max="28" data-num="codeFontSize" value="${c.config.codeFontSize}"> px`) +
      item("行間", "文字の大きさに対する行の高さ（既定 1.75）", `<input class="field num" type="number" step="0.05" min="1" max="3" data-num="lineHeight" value="${c.config.lineHeight}">`) +
      item("不可視文字を表示", "半角スペース ·、全角スペース □、タブ →、改行 ↵。ゼロ幅の文字などはいつも表示する", toggle("showInvisibles", c.config.showInvisibles)) +
      item(
        "Markdown の改行",
        "プレビューで、段落の中の改行をそのまま改行にするか、空行で段落を分けるか（CommonMark。行末の空白 2 つか \\ で改行）",
        (["newline", "blank-line"] as const)
          .map((v) => `<span class="btn ${c.config.markdownBreaks === v ? "pri" : ""}" data-mdbreaks="${v}">${v === "newline" ? "改行をそのまま改行" : "空行で改行"}</span>`)
          .join(""),
      ),
    onClick: async (el, c) => {
      const mb = el.closest<HTMLElement>("[data-mdbreaks]")?.dataset.mdbreaks;
      if (mb === "newline" || mb === "blank-line") {
        c.config.markdownBreaks = mb;
        await c.saveConfig();
        markdownHook.version++;
        c.refresh(["side"]);
        return true;
      }
      const k = el.closest<HTMLElement>("[data-toggle]")?.dataset.toggle;
      if (k !== "showInvisibles") return false;
      c.config.showInvisibles = !c.config.showInvisibles;
      await c.saveConfig();
      ctx.editors.forEach((e) => e.setInvisibles(c.config.showInvisibles));
      return true;
    },
    onChange: async (el, c) => {
      const k = el.dataset.num as "charsOverride" | "fontSize" | "codeFontSize" | "lineHeight" | undefined;
      if (!k) return false;
      const v = el.value === "" ? null : Number(el.value);
      if (k === "charsOverride") c.config.charsOverride = v;
      else c.config[k] = v ?? Number.NaN; // normalize puts the default back
      await c.saveConfig();
      allDocs(ctx.store.get()).forEach((d) => ctx.editors.get(d.path)?.setWidth(charsOf(d, c.config.charsOverride)));
      return true;
    },
  });
};
