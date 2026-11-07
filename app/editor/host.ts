// The editor pane: the open sheets, one editor each, in order (docs/adr/0006,
// docs/adr/0019). In vertical writing the sheets go from right to left, each
// with its heading at its right edge; switching keeps the editors.
// The correspondence between the state's sheets and the editors is kept here only.
import type { Ctx } from "../ctx.ts";
import { createEditor, type Editor } from "../ed/editor.ts";
import { esc } from "../esc.ts";
import { h } from "../icons.ts";
import { rel, stem } from "../path.ts";
import { loadManifest, separatorOf } from "../separator.ts";
import { focused, type Doc } from "../store.ts";
import { PROSE, verticalOn } from "../toolbar.ts";
import { item, toggle } from "../ui/settings.ts";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

/** The characters per line for a sheet: the setting, or style.toml's; code is wide. */
export const charsOf = (doc: Doc, override: number | null) => (["gm", "md", "txt"].includes(doc.kind) ? (override ?? doc.grid.chars) : 110);

const editorFor = (el: HTMLElement, doc: Doc, ctx: Ctx, index: number, scroller: HTMLElement | undefined): Editor => {
  const kindView = ctx.kindViews[doc.kind];
  if (kindView) return kindView(el, doc, ctx);
  return createEditor({
    parent: el,
    kind: doc.kind,
    text: doc.text,
    grid: doc.grid,
    chars: charsOf(doc, ctx.config.charsOverride),
    invisibles: ctx.config.showInvisibles,
    vertical: verticalOn(ctx.store.get()),
    style: PROSE.includes(doc.kind) ? "prose" : "code",
    scroller,
    base: () => ctx.baseText(doc),
    onChange: (text) => ctx.store.dispatch({ type: "edit", path: doc.path, text }),
    onSave: () => void ctx.save([doc.path], { explicit: true }),
    onFocus: () => ctx.store.dispatch({ type: "focus", index }),
    onCaret: () => ctx.refresh(["status"]),
    plugins: ctx.editorPlugins.flatMap((f) => f(doc, ctx) ?? []),
    separator: () => separatorOf(doc.project, doc.path, ctx.editors.get(doc.path)?.text() ?? doc.text),
  });
};

export const mountEditors = (ctx: Ctx) => {
  ctx.view.main = (el) => {
    const s = ctx.store.get();
    if (s.plot) return ctx.kindViews.plot?.(el, focused(s) ?? ({ path: `${s.plot}/plot.csv`, project: s.plot } as Doc), ctx).destroy;
    const many = s.open.length > 1;
    const host = h(`<div class="${many ? "multi" : "single"}${verticalOn(s) ? " vertical" : ""}"></div>`);
    el.append(host);
    // the manifest decides the paragraph separator of the page break estimates
    for (const p of new Set(s.open.flatMap((d) => (d.project ? [d.project] : []))))
      void loadManifest(p).then(() => s.open.forEach((d) => d.project === p && ctx.editors.get(d.path)?.refreshMarks()));
    s.open.forEach((doc, i) => {
      const sec = many
        ? h(`<section class="msec"><div class="mhead">${esc(ctx.titles.get(doc.path) ?? stem(doc.path))}<small>${esc(doc.workspace ? rel(doc.workspace, doc.path) : doc.path)}</small></div><div class="mhost"></div></section>`)
        : h(`<div class="mhost single-host"></div>`);
      host.append(sec);
      ctx.editors.set(doc.path, editorFor(sec.querySelector<HTMLElement>(".mhost") ?? sec, doc, ctx, i, many ? host : undefined));
    });
    // the vertical switch changes the writing mode of the editors in place
    let vertical = verticalOn(s);
    const off = ctx.store.subscribe((now) => {
      const v = verticalOn(now);
      if (v === vertical) return;
      vertical = v;
      host.classList.toggle("vertical", v);
      // back to the start (the top, or the right edge); the editor with the caret then scrolls to it
      host.scrollTop = 0;
      host.scrollLeft = 0;
      ctx.editors.forEach((e) => e.setVertical(v));
    });
    const at = ctx.pendingAt;
    ctx.pendingAt = null;
    const first = s.open[0] && ctx.editors.get(s.open[0].path);
    if (at) first?.goto(at.line, at.col);
    else first?.focus();
    return () => {
      off();
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
    const core = (focused(s) && ctx.editors.get(focused(s)!.path))?.edit?.core;
    if (!core) return "";
    const head = core.sel().head;
    const line = core.doc().lineAt(head);
    return `<span>行 ${line.number}, 列 ${head - line.from + 1}</span>`;
  });

  // the screen that records input events for the editor's tests (docs/adr/0019)
  ctx.commands.push({
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
