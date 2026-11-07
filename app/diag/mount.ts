// The diagnostics of golem check, lint and preflight (docs/adr/0015): the
// left panel, the status bar items, and the runs after opening and saving.
import type { Ctx } from "../ctx.ts";
import { esc } from "../esc.ts";
import { icon } from "../icons.ts";
import { basename } from "../path.ts";
import { allDocs, focused } from "../store.ts";
import { golem } from "../tools.ts";
import { parseDiagnostics, sortDiagnostics, statusOf, type Diagnostic, type Result } from "./parse.ts";

export type Kind = "check" | "lint" | "preflight";
const KINDS: Kind[] = ["check", "lint", "preflight"];

const results = new Map<string, { result: Result; at: string }>();
const running = new Set<string>();
const key = (project: string, kind: Kind) => `${project}\n${kind}`;
let shown: { project: string | null; kind: Kind } = { project: null, kind: "check" };

/** golem <kind> --format json; the JSON is on standard error. check and lint take -v for infos; preflight does not accept it. */
export const runDiag = async (ctx: Ctx, project: string, kind: Kind) => {
  const k = key(project, kind);
  if (running.has(k)) return;
  running.add(k);
  ctx.refresh(["status", "left"]);
  const args = kind === "preflight" ? ["preflight", "--format", "json"] : [kind, "--format", "json", "-v"];
  const out = await golem(ctx, project, args).catch((e) => ({ code: -1, stdout: "", stderr: String(e) }));
  const r = parseDiagnostics(out.stderr);
  const done = { result: r.raw === "" && out.code !== 0 ? { items: [], raw: out.stdout.trim() || `終了コード ${out.code}` } : r, at: new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }) };
  results.set(k, done);
  running.delete(k);
  ctx.refresh(["status", "left"]);
  return done.result;
};

const SEV: Record<Diagnostic["severity"], [string, string]> = {
  error: ["circle-x", "エラー"],
  warning: ["triangle-alert", "警告"],
  notice: ["info", "notice"],
  info: ["info", "info"],
};

const itemHtml = (d: Diagnostic, i: number) =>
  `<div class="dgi ${d.severity}" data-i="${i}" title="${esc(SEV[d.severity]?.[1] ?? d.severity)}">${icon(SEV[d.severity]?.[0] ?? "info", 13)}<div class="dgb"><div>${esc(d.message)}</div><small>${esc(d.code)}${
    d.span ? ` · ${d.span.line} 行 ${d.span.column} 列` : ""
  }${d.facts && Object.keys(d.facts).length ? ` · ${Object.entries(d.facts).map(([k, v]) => `${esc(k)}: ${esc(v)}`).join("、")}` : ""}</small>${(d.related ?? [])
    .map((r) => `<small class="rel">${esc(r.message ?? "")}${r.span ? `（${esc(r.span.file)} ${r.span.line} 行）` : ""}</small>`)
    .join("")}</div></div>`;

const drawPanel = (el: HTMLElement, ctx: Ctx) => {
  const project = shown.project ?? focused(ctx.store.get())?.project ?? ctx.projects[0] ?? null;
  shown.project = project;
  if (!project) return void (el.innerHTML = `<div class="sec"><div class="muted">Golem のプロジェクトがありません。</div></div>`);
  const k = key(project, shown.kind);
  const r = results.get(k);
  const items = r ? sortDiagnostics(r.result.items) : [];
  const files = [...new Set(items.map((d) => d.span?.file ?? ""))];
  el.innerHTML = `<div class="diag">
    <div class="sec"><select class="field wide" data-project>${ctx.projects.map((p) => `<option value="${esc(p)}" ${p === project ? "selected" : ""}>${esc(basename(p))}</option>`).join("")}</select>
      <div class="row">${KINDS.map((x) => `<span class="btn ${x === shown.kind ? "pri" : ""}" data-kind="${x}">${x}${running.has(key(project, x)) ? "…" : ""}</span>`).join("")}<span class="btn" data-run title="もう一度実行する">${icon("refresh-cw", 12)}</span></div>
      <div class="muted">${running.has(k) ? "実行しています…" : r ? `${r.at} に実行 · ${items.length} 件` : "まだ実行していません"}</div></div>
    ${
      r?.result.raw
        ? `<div class="sec"><pre class="error">${esc(r.result.raw)}</pre></div>`
        : files
            .map((f) => `<div class="sec"><h5>${esc(f || "（位置のない診断）")}</h5>${items.map((d, i) => ((d.span?.file ?? "") === f ? itemHtml(d, i) : "")).join("")}</div>`)
            .join("")
    }</div>`;
  el.onchange = (e) => {
    const t = e.target as HTMLSelectElement;
    if (t.dataset.project === undefined) return;
    shown.project = t.value;
    drawPanel(el, ctx);
  };
  el.onclick = (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>("[data-kind],[data-run],[data-i]");
    if (!t) return;
    if (t.dataset.kind) {
      shown.kind = t.dataset.kind as Kind;
      if (!results.has(key(project, shown.kind))) void runDiag(ctx, project, shown.kind);
      return drawPanel(el, ctx);
    }
    if (t.dataset.run !== undefined) return void runDiag(ctx, project, shown.kind);
    const d = items[Number(t.dataset.i)];
    if (d?.span) void ctx.open([`${project}/${d.span.file}`], { line: d.span.line, col: Math.max(0, d.span.column - 1) });
  };
};

/** Shows a project's result of `kind` in the panel. */
export const showDiag = (ctx: Ctx, project: string, kind: Kind) => {
  shown = { project, kind };
  const s = ctx.store.get();
  // the same panel's icon folds it, so only switch when it is not shown
  if (s.left !== "diagnostics" || !s.showLeft) ctx.store.dispatch({ type: "left", panel: "diagnostics" });
  else ctx.refresh(["left"]);
};

/** Lint and preflight for some projects now (a replace's files changed on disk, docs/adr/0041); set by the mount. */
export const diagHooks: { recheck: (projects: string[]) => Promise<void> } = { recheck: async () => {} };

export const mountDiagnostics = (ctx: Ctx) => {
  ctx.left.diagnostics = { icon: "list-checks", title: "診断", render: (el) => drawPanel(el, ctx) };

  // lint and preflight beside the LSP in the status bar
  ctx.status.push((s) => {
    const project = focused(s)?.project;
    if (!project) return "";
    return (["lint", "preflight"] as const)
      .map((kind) => {
        const r = results.get(key(project, kind));
        const st = statusOf(r?.result ?? null);
        return `<span class="chk ${st.cls} ${running.has(key(project, kind)) ? "running" : ""}" data-status="diag-${kind}" title="${kind} の結果を診断のパネルに出す">● ${kind}${st.count ? ` ${st.count}` : ""}</span>`;
      })
      .join("");
  });
  for (const kind of ["lint", "preflight"] as const)
    ctx.statusActions[`diag-${kind}`] = (c) => {
      const project = focused(c.store.get())?.project;
      if (project) showDiag(c, project, kind);
    };

  // when a project is opened, and 2.5 s after saving its .gm, .emet, .toml or .json (docs/adr/0021): lint, then preflight
  const background = async (project: string) => {
    await runDiag(ctx, project, "lint");
    await runDiag(ctx, project, "preflight");
  };
  const opened = new Set<string>();
  const timers = new Map<string, number>();
  // after a replace across the workspace (docs/adr/0041): at once, the pending runs after saving dropped
  diagHooks.recheck = async (projects) => {
    for (const p of projects) {
      clearTimeout(timers.get(p));
      timers.delete(p);
      await background(p);
    }
  };
  ctx.store.subscribe((s, prev) => {
    for (const d of allDocs(s)) {
      if (!d.project) continue;
      if (!opened.has(d.project)) {
        opened.add(d.project);
        void background(d.project);
      }
      const before = allDocs(prev).find((x) => x.path === d.path);
      if (before && before.saved !== d.saved && /\.(gm|emet|toml|json)$/.test(d.path)) {
        clearTimeout(timers.get(d.project));
        const p = d.project;
        timers.set(p, window.setTimeout(() => void background(p), 2500));
      }
    }
  });
};
