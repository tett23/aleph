import type { Ctx } from "../ctx.ts";
import { compareLines, markAtLine } from "../diff.ts";
import { esc } from "../esc.ts";
import { icon } from "../icons.ts";
import { rel } from "../path.ts";
import { allDocs, type State } from "../store.ts";
import { snapshotDiff, type SheetSnapshot } from "./snapshot.ts";
import { diffLineHtml } from "./text.ts";

export const activeSnapshot = (s: State) => s.panes.flatMap((p) => p.tabs).find((t) => t.diff)?.snapshot;

export const drawSnapshot = (ctx: Pick<Ctx, "store" | "editors" | "baseText">, head: HTMLElement, body: HTMLElement, snapshot: SheetSnapshot) => {
  const { path, workspace } = snapshot;
  const name = workspace ? rel(workspace, path) : path;
  const timing = snapshot.reloaded ? "再読み込み時点" : "クリック時点";
  head.classList.add("snapshot-head");
  head.innerHTML = `<span class="dws" title="${esc(path)}">${esc(name)}</span><span>${timing}の差分（未保存の編集を含む）</span><span class="sp"></span>
    <button class="btn small" type="button" data-snapshot-workspace>ワークスペース全体の差分</button>
    <button class="btn small" type="button" data-snapshot-reload>${icon("refresh-cw", 12)} 再読み込み</button>`;
  const note = document.createElement("div");
  note.className = "muted dline";
  note.setAttribute("role", "status");
  note.hidden = true;
  const { lines, omittedBefore, omittedAfter, target } = snapshotDiff(snapshot.base, snapshot.text, snapshot.runs, snapshot.selected);
  const omitted = (n: number, direction: "前" | "後") => n ? `<div class="muted dmore">${direction}に ${n} 行を省略</div>` : "";
  const html = lines.map((line, i) => {
    const text = diffLineHtml(line);
    return i === target ? `<span data-snapshot-target>${text}</span>` : text;
  }).join("\n");
  body.onclick = null;
  body.innerHTML = lines.length
    ? `<section class="dfile snapshot-diff">${omitted(omittedBefore, "前")}<pre>${html}</pre>${omitted(omittedAfter, "後")}</section>`
    : '<div class="muted dline">HEAD との差分はありません</div>';
  body.prepend(note);
  body.scrollTop = 0;
  const mark = body.querySelector("[data-snapshot-target]");
  if (mark) {
    const top = mark.getBoundingClientRect().top;
    const view = body.getBoundingClientRect();
    if (omittedBefore || top >= view.bottom) body.scrollTop = Math.max(0, top - view.top - body.clientHeight / 3);
  }
  head.onclick = null;
  let request = 0;
  const showNote = (message: string) => {
    note.textContent = message;
    note.hidden = !message;
  };
  head.querySelector<HTMLButtonElement>("[data-snapshot-workspace]")!.onclick = () => ctx.store.dispatch({ type: "showDiff" });
  head.querySelector<HTMLButtonElement>("[data-snapshot-reload]")!.onclick = async () => {
    const mine = ++request;
    const editor = ctx.editors.get(path);
    const doc = allDocs(ctx.store.get()).find((d) => d.path === path);
    const closed = () => showNote("対象のエディタが閉じているため、差分を再読み込みできません。");
    if (!editor || !doc) return closed();
    showNote("比較元を読み込み中…");
    const base = await ctx.baseText(doc).catch(() => false as const);
    if (!note.isConnected || mine !== request || activeSnapshot(ctx.store.get()) !== snapshot) return;
    if (ctx.editors.get(path) !== editor) return closed();
    if (base === false) return showNote("比較元を取得できません。");
    const text = editor.text();
    const comparison = compareLines(base, text);
    const selected = markAtLine(comparison, snapshot.line);
    const line = selected.length ? snapshot.line : [...comparison.byLine.keys()].reduce((nearest, candidate) =>
      Math.abs(candidate - snapshot.line) < Math.abs(nearest - snapshot.line) ? candidate : nearest, Infinity);
    const next: SheetSnapshot = {
      ...snapshot, base, text, reloaded: true, runs: comparison.runs,
      selected: markAtLine(comparison, line), line: Number.isFinite(line) ? line : snapshot.line,
    };
    ctx.store.dispatch({ type: "replaceDiffSnapshot", previous: snapshot, snapshot: next });
  };
};
