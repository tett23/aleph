// Searching (docs/adr/0015): in this project, this workspace or all of them,
// plain or by regex, with or without case; the Rust side walks the files.
// Replacing (docs/adr/0032): all matches or the chosen ones, open sheets in
// their editors as one change, the rest on disk, with the same Rust regex.
// The input is drawn once and only the results are drawn again, so typing is never lost.
import { addCommands } from "./commands.ts";
import { api, type Found } from "./api.ts";
import type { Ctx } from "./ctx.ts";
import { esc } from "./esc.ts";
import { icon } from "./icons.ts";
import { rel } from "./path.ts";
import { allDocs, focused } from "./store.ts";
import { diffText } from "./ed/ime.ts";
import { afterHtml, confirmText, projectsTouched, spotsOf } from "./replace.ts";
import { diagHooks } from "./diag/mount.ts";
import { git } from "./tools.ts";
import { confirmDialog } from "./ui/dom.ts";
import { reloadTree } from "./ui/tree.ts";
import { TEXT_KINDS, workspaceOf } from "./workspace.ts";

type Scope = "project" | "workspace" | "all";
const LIMIT = 2000;

const opts = { query: "", scope: "workspace" as Scope, regex: false, caseSensitive: false, with: "" };
/** The hits not chosen for replacing (by index into the last result). */
let unchosen = new Set<number>();
let last: Found | null = null;
let seq = 0;

const rootsOf = (ctx: Ctx, scope: Scope): string[] => {
  const s = ctx.store.get();
  if (scope === "all") return s.workspaces;
  if (scope === "project") {
    const p = focused(s)?.project;
    return p ? [p] : [];
  }
  return s.workspace ? [s.workspace] : [];
};

const matchedOf = (h: Found["hits"][number]) => [...h.text].slice(h.start, h.end).join("");

const hitHtml = (h: Found["hits"][number], i: number, after: string | null) => {
  const cs = [...h.text];
  const line =
    after === null
      ? `${esc(cs.slice(0, h.start).join(""))}<mark>${esc(cs.slice(h.start, h.end).join(""))}</mark>${esc(cs.slice(h.end).join(""))}`
      : afterHtml(h.text, h.start, h.end, after);
  const pick = after === null ? "" : `<input type="checkbox" data-pick="${i}" ${unchosen.has(i) ? "" : "checked"}>`;
  return `<div class="hit" data-h="${i}">${pick}<span class="ln">${h.line}</span><span class="tx">${line}</span></div>`;
};

const drawResults = async (box: HTMLElement, ctx: Ctx, found: Found | string | null) => {
  if (typeof found !== "string" && found !== last) unchosen = new Set();
  last = typeof found === "string" ? null : found;
  if (found === null) return void (box.innerHTML = "");
  if (typeof found === "string") return void (box.innerHTML = `<div class="muted">${esc(found)}</div>`);
  const ws = ctx.store.get().workspaces;
  const label = (p: string) => {
    const w = workspaceOf(p, ws);
    return w ? rel(w, p) : p;
  };
  const files = [...new Set(found.hits.map((h) => h.path))];
  // with a replacement, each line shows what it becomes (the Rust regex's expansion)
  const afters = opts.with
    ? await api.replacePreview({ matched: found.hits.map(matchedOf), pattern: opts.query, regex: opts.regex, caseSensitive: opts.caseSensitive, with: opts.with }).catch(() => null)
    : null;
  box.innerHTML =
    `<div class="muted">${found.hits.length} 件${found.truncated ? `（${LIMIT} 件で打ち切りました）` : ""}・${files.length} ファイル</div>` +
    files
      .map(
        (f) =>
          `<div class="hitfile"><div class="hf">${afters ? `<input type="checkbox" data-pickfile="${esc(f)}" ${found.hits.some((h, i) => h.path === f && unchosen.has(i)) ? "" : "checked"}>` : ""}${icon("file-text", 13)}<span>${esc(label(f))}</span></div>${found.hits
            .map((h, i) => (h.path === f ? hitHtml(h, i, afters ? afters[i] : null) : ""))
            .join("")}</div>`,
      )
      .join("");
  box.onchange = (e) => {
    const t = e.target as HTMLInputElement;
    if (t.dataset.pick !== undefined) {
      const i = Number(t.dataset.pick);
      if (t.checked) unchosen.delete(i);
      else unchosen.add(i);
    } else if (t.dataset.pickfile !== undefined) {
      found.hits.forEach((h, i) => {
        if (h.path !== t.dataset.pickfile) return;
        if (t.checked) unchosen.delete(i);
        else unchosen.add(i);
      });
      box.querySelectorAll<HTMLInputElement>(`[data-pick]`).forEach((c) => (c.checked = !unchosen.has(Number(c.dataset.pick))));
    }
  };
  box.onclick = (e) => {
    if ((e.target as HTMLElement).closest("input")) return;
    const i = (e.target as HTMLElement).closest<HTMLElement>("[data-h]")?.dataset.h;
    const h = i === undefined ? null : found.hits[Number(i)];
    if (h) void ctx.open([h.path], { line: h.line, col: h.column });
  };
};

const isGit = async (ctx: Ctx, root: string) => {
  const r = await git(ctx, root, ["rev-parse", "--is-inside-work-tree"]).catch(() => null);
  return !!r && r.code === 0;
};

/** Replaces the chosen matches (or all of them) across the scope, after saving the open sheets and asking. */
const replaceRun = async (ctx: Ctx, all: boolean, rerun: () => Promise<Found | string | null>) => {
  const roots = rootsOf(ctx, opts.scope);
  if (!opts.query || !roots.length) return;
  const inScope = (p: string) => roots.some((r) => p.startsWith(r + "/"));
  // the disk and the editors agree first; then the search is run again
  const open = allDocs(ctx.store.get()).filter((d) => inScope(d.path));
  if (open.length) await ctx.save(open.map((d) => d.path));
  // the choice kept across the new search: hits left out are matched by their place
  const key = (h: { path: string; line: number; column: number }) => `${h.path}:${h.line}:${h.column}`;
  const off = new Set((last?.hits ?? []).flatMap((h, i) => (unchosen.has(i) ? [key(h)] : [])));
  const found = await rerun();
  if (!found || typeof found === "string") return;
  unchosen = new Set(found.hits.flatMap((h, i) => (off.has(key(h)) ? [i] : [])));
  const chosen = new Set(found.hits.flatMap((h, i) => (off.has(key(h)) ? [] : [i])));
  const hits = found.hits.map((h) => ({ path: h.path, line: h.line, column: h.column, matched: matchedOf(h) }));
  const only = all ? null : spotsOf(hits, chosen);
  const files = all ? new Set(hits.map((h) => h.path)).size : Object.keys(only!).length;
  const count = all ? hits.length : chosen.size;
  if (!count) return ctx.toast("置換する一致がありません");
  const git = (await Promise.all(roots.map((r) => isGit(ctx, r)))).every(Boolean);
  if (!(await confirmDialog(confirmText(files, count, git, all && found.truncated), "置換する"))) return;
  const args = { pattern: opts.query, regex: opts.regex, caseSensitive: opts.caseSensitive, with: opts.with };
  let replaced = 0;
  let skipped = 0;
  const touched = new Set<string>();
  // open sheets: in their editors, one change each (⌘Z undoes it at once)
  for (const d of open) {
    const t = ctx.editors.get(d.path)?.edit;
    if (!t || (only && !only[d.path])) continue;
    const r = await api.replaceText({ ...args, text: t.core.text(), only: only ? only[d.path] : null });
    const change = diffText(t.core.text(), r.text);
    if (change) t.apply([change], "replace-all");
    replaced += r.replaced;
    skipped += r.skipped;
    if (r.replaced) touched.add(d.path);
  }
  const rs = await api.replaceFiles({ roots, pattern: opts.query, regex: opts.regex, case_sensitive: opts.caseSensitive, kinds: [...TEXT_KINDS, "mermaid"], with: opts.with, only, leave: open.map((d) => d.path) });
  for (const r of rs) {
    replaced += r.replaced;
    skipped += r.skipped;
    if (r.replaced) touched.add(r.path);
  }
  ctx.toast(`${touched.size} ファイルの ${replaced} 件を置換しました${skipped ? `（${skipped} 件は変わっていたので飛ばしました）` : ""}`);
  // as after a save: the marks, the tree, the Git panel and the lint
  if (open.some((d) => touched.has(d.path))) await ctx.save(open.filter((d) => touched.has(d.path)).map((d) => d.path));
  await reloadTree(ctx);
  ctx.refresh(["left"]);
  await rerun();
  // the files changed on disk get their lint and preflight too (docs/adr/0041)
  await diagHooks.recheck(projectsTouched([...touched], ctx.projects));
};

export const mountSearch = (ctx: Ctx) => {
  let built: HTMLElement | null = null;
  ctx.left.search = {
    icon: "search",
    title: "検索",
    render: (el) => {
      // the panel is drawn once into its element; later draws keep the input
      if (built && el.contains(built)) return;
      el.innerHTML = `<div class="search">
        <input class="field wide" data-q placeholder="検索" value="${esc(opts.query)}" spellcheck="false">
        <div class="row">
          <select class="field" data-scope>${(
            [
              ["project", "このプロジェクト"],
              ["workspace", "このワークスペース"],
              ["all", "すべてのワークスペース"],
            ] as const
          )
            .map(([k, l]) => `<option value="${k}" ${opts.scope === k ? "selected" : ""}>${l}</option>`)
            .join("")}</select>
          <span class="btn ${opts.regex ? "pri" : ""}" data-opt="regex" title="正規表現">.*</span>
          <span class="btn ${opts.caseSensitive ? "pri" : ""}" data-opt="case" title="大文字と小文字を区別する">Aa</span>
        </div>
        <input class="field wide" data-with placeholder="置換（正規表現では $1、\${name}、$$）" value="${esc(opts.with)}" spellcheck="false">
        <div class="row reprow"><span class="btn" data-rep="chosen">選んだものを置換</span><span class="btn" data-rep="all">すべて置換</span></div>
        <div class="results"></div></div>`;
      built = el.querySelector<HTMLElement>(".search");
      const input = el.querySelector<HTMLInputElement>("[data-q]")!;
      const box = el.querySelector<HTMLElement>(".results")!;
      let timer = 0;
      /** Searches now and draws; returns what was found. */
      const now = async (): Promise<Found | string | null> => {
        const n = ++seq;
        if (!opts.query) return (await drawResults(box, ctx, null), null);
        const roots = rootsOf(ctx, opts.scope);
        if (!roots.length) {
          const why = opts.scope === "project" ? "Golem のプロジェクトのシートを開いてください" : "ワークスペースがありません";
          return (await drawResults(box, ctx, why), why);
        }
        const found = await api
          .search({ roots, pattern: opts.query, regex: opts.regex, case_sensitive: opts.caseSensitive, kinds: [...TEXT_KINDS, "mermaid"], limit: LIMIT })
          .catch((e: unknown) => `正規表現として読めません：${String(e)}`);
        if (n === seq) await drawResults(box, ctx, found);
        return found;
      };
      const run = () => {
        clearTimeout(timer);
        timer = window.setTimeout(() => void now(), 200);
      };
      el.querySelector<HTMLInputElement>("[data-with]")!.addEventListener("input", (e) => {
        opts.with = (e.target as HTMLInputElement).value;
        // the lines after the replacement are drawn again from the same hits
        clearTimeout(timer);
        timer = window.setTimeout(() => void drawResults(box, ctx, last), 200);
      });
      el.querySelectorAll<HTMLElement>("[data-rep]").forEach((b) => b.addEventListener("click", () => void replaceRun(ctx, b.dataset.rep === "all", now)));
      input.addEventListener("input", () => {
        opts.query = input.value;
        run();
      });
      el.querySelector<HTMLSelectElement>("[data-scope]")!.addEventListener("change", (e) => {
        opts.scope = (e.target as HTMLSelectElement).value as Scope;
        run();
      });
      el.querySelectorAll<HTMLElement>("[data-opt]").forEach((b) =>
        b.addEventListener("click", () => {
          if (b.dataset.opt === "regex") opts.regex = !opts.regex;
          else opts.caseSensitive = !opts.caseSensitive;
          b.classList.toggle("pri");
          run();
        }),
      );
      input.focus();
      run();
    },
  };
  // ⇧⌘F, a command (docs/adr/0023): the search panel with its field focused
  addCommands(ctx.commands, {
    id: "view.left.search",
    keys: ["Mod-Shift-f"],
    label: "検索",
    icon: "search",
    when: () => true,
    run: (c) => {
      const s = c.store.get();
      if (s.left !== "search" || !s.showLeft) c.store.dispatch({ type: "left", panel: "search" });
      setTimeout(() => document.querySelector<HTMLInputElement>(".search [data-q]")?.focus(), 50);
    },
  });
};
