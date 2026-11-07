// The editor pane: the open sheets, one editor each, in order (docs/adr/0006).
// The correspondence between the state's sheets and the editors is kept here only.
import type { Ctx } from "../ctx.ts";
import { esc } from "../esc.ts";
import { h } from "../icons.ts";
import { rel, stem } from "../path.ts";
import { focused, type Doc } from "../store.ts";
import { canVertical } from "../toolbar.ts";
import { item, toggle } from "../ui/settings.ts";
import { createEditor, type Editor } from "./cm.ts";
import { loadManifest, separatorOf } from "../separator.ts";

/** The characters per line for a sheet: the setting, or style.toml's; code is wide. */
export const charsOf = (doc: Doc, override: number | null) => (["gm", "md", "txt"].includes(doc.kind) ? (override ?? doc.grid.chars) : 110);

const editorFor = (el: HTMLElement, doc: Doc, ctx: Ctx, index: number): Editor => {
  const s = ctx.store.get();
  const kindView = ctx.kindViews[doc.kind];
  if (kindView) return kindView(el, doc, ctx);
  if (s.vertical && s.open.length === 1 && canVertical(doc.kind) && ctx.verticalEditor) return ctx.verticalEditor(el, doc, ctx);
  return createEditor({
    parent: el,
    kind: doc.kind,
    text: doc.text,
    grid: doc.grid,
    chars: charsOf(doc, ctx.config.charsOverride),
    invisibles: ctx.config.showInvisibles,
    base: () => ctx.baseText(doc),
    onChange: (text) => ctx.store.dispatch({ type: "edit", path: doc.path, text }),
    onSave: () => void ctx.save([doc.path], { explicit: true }),
    onFocus: () => ctx.store.dispatch({ type: "focus", index }),
    extensions: ctx.editorExtensions.flatMap((f) => f(doc, ctx)),
    separator: () => separatorOf(doc.project, doc.path, ctx.editors.get(doc.path)?.text() ?? doc.text),
  });
};

export const mountEditors = (ctx: Ctx) => {
  ctx.view.main = (el) => {
    const s = ctx.store.get();
    if (s.plot) return ctx.kindViews.plot?.(el, focused(s) ?? ({ path: `${s.plot}/plot.csv`, project: s.plot } as Doc), ctx).destroy;
    const many = s.open.length > 1;
    const host = h(`<div class="${many ? "multi" : "single"}"></div>`);
    el.append(host);
    // the manifest decides the paragraph separator of the page break estimates
    for (const p of new Set(s.open.flatMap((d) => (d.project ? [d.project] : []))))
      void loadManifest(p).then(() => s.open.forEach((d) => d.project === p && ctx.editors.get(d.path)?.refreshMarks()));
    s.open.forEach((doc, i) => {
      const sec = many
        ? h(`<section class="msec"><div class="mhead">${esc(ctx.titles.get(doc.path) ?? stem(doc.path))}<small>${esc(doc.workspace ? rel(doc.workspace, doc.path) : doc.path)}</small></div><div class="mhost"></div></section>`)
        : h(`<div class="mhost single-host"></div>`);
      host.append(sec);
      ctx.editors.set(doc.path, editorFor(sec.querySelector<HTMLElement>(".mhost") ?? sec, doc, ctx, i));
    });
    const status = () => ctx.refresh(["status"]);
    host.addEventListener("keyup", status);
    host.addEventListener("mouseup", status);
    const at = ctx.pendingAt;
    ctx.pendingAt = null;
    const first = s.open[0] && ctx.editors.get(s.open[0].path);
    if (at) first?.goto(at.line, at.col);
    else first?.view?.focus();
    return () => {
      ctx.editors.forEach((e) => e.destroy());
      ctx.editors.clear();
    };
  };

  // the grid and the caret in the status bar
  ctx.status.push((s) => {
    const d = focused(s);
    if (!d || !d.project) return "";
    const chars = charsOf(d, ctx.config.charsOverride);
    return `<span>${chars} 字 × ${d.grid.lines} 行${ctx.config.charsOverride ? "（上書き）" : ""}${d.grid.vertical ? " · 縦組み" : ""}</span>`;
  });
  ctx.status.push((s) => {
    const v = (focused(s) && ctx.editors.get(focused(s)!.path))?.view;
    if (!v) return "";
    const head = v.state.selection.main.head;
    const line = v.state.doc.lineAt(head);
    return `<span>行 ${line.number}, 列 ${head - line.from + 1}</span>`;
  });

  ctx.settings.push({
    id: "editor",
    label: "エディタ",
    group: "オプション",
    render: (c) =>
      item("1 行の字数", "空なら style.toml の [page.grid] characters", `<input class="field num" type="number" min="5" max="200" data-num="charsOverride" value="${c.config.charsOverride ?? ""}" placeholder="—">`) +
      item("本文の文字サイズ", "gm、md、txt のエディタ、縦書き、本文のプレビュー（既定 16 px）", `<input class="field num" type="number" min="10" max="32" data-num="fontSize" value="${c.config.fontSize}"> px`) +
      item("コードの文字サイズ", "toml、emet などのエディタ（既定 13 px）", `<input class="field num" type="number" min="9" max="28" data-num="codeFontSize" value="${c.config.codeFontSize}"> px`) +
      item("行間", "文字の大きさに対する行の高さ（既定 1.75）", `<input class="field num" type="number" step="0.05" min="1" max="3" data-num="lineHeight" value="${c.config.lineHeight}">`) +
      item("不可視文字を表示", "半角スペース ·、全角スペース □、タブ →、改行 ↵。ゼロ幅の文字などはいつも表示する", toggle("showInvisibles", c.config.showInvisibles)),
    onClick: async (el, c) => {
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
      ctx.store.get().open.forEach((d) => ctx.editors.get(d.path)?.setWidth(charsOf(d, c.config.charsOverride)));
      return true;
    },
  });
};
