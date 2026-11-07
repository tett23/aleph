// Searching (docs/adr/0015): in this project, this workspace or all of them,
// plain or by regex, with or without case; the Rust side walks the files.
// The input is drawn once and only the results are drawn again, so typing is never lost.
import { api, type Found } from "./api.ts";
import type { Ctx } from "./ctx.ts";
import { esc } from "./esc.ts";
import { icon } from "./icons.ts";
import { rel } from "./path.ts";
import { focused } from "./store.ts";
import { TEXT_KINDS, workspaceOf } from "./workspace.ts";

type Scope = "project" | "workspace" | "all";
const LIMIT = 2000;

const opts = { query: "", scope: "workspace" as Scope, regex: false, caseSensitive: false };
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

const hitHtml = (h: Found["hits"][number], i: number) => {
  const cs = [...h.text];
  return `<div class="hit" data-h="${i}"><span class="ln">${h.line}</span><span class="tx">${esc(cs.slice(0, h.start).join(""))}<mark>${esc(cs.slice(h.start, h.end).join(""))}</mark>${esc(cs.slice(h.end).join(""))}</span></div>`;
};

const drawResults = (box: HTMLElement, ctx: Ctx, found: Found | string | null) => {
  if (found === null) return void (box.innerHTML = "");
  if (typeof found === "string") return void (box.innerHTML = `<div class="muted">${esc(found)}</div>`);
  const ws = ctx.store.get().workspaces;
  const label = (p: string) => {
    const w = workspaceOf(p, ws);
    return w ? rel(w, p) : p;
  };
  const files = [...new Set(found.hits.map((h) => h.path))];
  box.innerHTML =
    `<div class="muted">${found.hits.length} 件${found.truncated ? `（${LIMIT} 件で打ち切りました）` : ""}・${files.length} ファイル</div>` +
    files
      .map((f) => `<div class="hitfile"><div class="hf">${icon("file-text", 13)}<span>${esc(label(f))}</span></div>${found.hits.map((h, i) => (h.path === f ? hitHtml(h, i) : "")).join("")}</div>`)
      .join("");
  box.onclick = (e) => {
    const i = (e.target as HTMLElement).closest<HTMLElement>("[data-h]")?.dataset.h;
    const h = i === undefined ? null : found.hits[Number(i)];
    if (h) void ctx.open([h.path], { line: h.line, col: h.column });
  };
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
        <div class="results"></div></div>`;
      built = el.querySelector<HTMLElement>(".search");
      const input = el.querySelector<HTMLInputElement>("[data-q]")!;
      const box = el.querySelector<HTMLElement>(".results")!;
      let timer = 0;
      const run = () => {
        clearTimeout(timer);
        timer = window.setTimeout(async () => {
          const n = ++seq;
          if (!opts.query) return drawResults(box, ctx, null);
          const roots = rootsOf(ctx, opts.scope);
          if (!roots.length) return drawResults(box, ctx, opts.scope === "project" ? "Golem のプロジェクトのシートを開いてください" : "ワークスペースがありません");
          const found = await api
            .search({ roots, pattern: opts.query, regex: opts.regex, case_sensitive: opts.caseSensitive, kinds: [...TEXT_KINDS, "mermaid"], limit: LIMIT })
            .catch((e: unknown) => `正規表現として読めません：${String(e)}`);
          if (n === seq) drawResults(box, ctx, found);
        }, 200);
      };
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
  window.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "f") {
      e.preventDefault();
      const s = ctx.store.get();
      if (s.left !== "search" || !s.showLeft) ctx.store.dispatch({ type: "left", panel: "search" });
      setTimeout(() => document.querySelector<HTMLInputElement>(".search [data-q]")?.focus(), 50);
    }
  });
};
