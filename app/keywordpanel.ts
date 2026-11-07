// The keywords panel in the left sidebar (docs/adr/0028): the writer's keywords
// of every root of the workspace with their counts, and the plot's names by
// column; pressing one lists its sheets, ⌘ narrows to sheets with all chosen.
import { addCommands } from "./commands.ts";
import { loadMeta, putMeta } from "./attach.ts";
import type { Ctx } from "./ctx.ts";
import { esc } from "./esc.ts";
import { collectKeywords, plotKeywords, plotSheetsWith, removeEverywhere, renameEverywhere, sheetsWith, type PlotKeywords, type Root } from "./keywords.ts";
import { basename, rel } from "./path.ts";
import { plotRows } from "./plot/mount.ts";
import { ask, confirmDialog, menu } from "./ui/dom.ts";
import { icon } from "./icons.ts";

/** The chosen keywords: the writer's (several, with ⌘) or one of the plot's. */
let chosen: { kind: "mine" | "plot"; names: string[] } = { kind: "mine", names: [] };

const rootsOf = (ctx: Ctx): string[] => {
  const ws = ctx.store.get().workspace;
  return ws ? [ws, ...ctx.projects.filter((p) => p.startsWith(ws + "/"))] : [];
};

const loadRoots = async (ctx: Ctx): Promise<Root[]> => Promise.all(rootsOf(ctx).map(async (root) => ({ root, meta: await loadMeta(root) })));

const loadPlots = async (ctx: Ctx) =>
  Promise.all(rootsOf(ctx).slice(1).map(async (project) => ({ project, rows: await plotRows(project) })));

const SOURCES: [keyof PlotKeywords, string][] = [
  ["pov", "視点人物"],
  ["characters", "登場人物"],
  ["place", "場所"],
  ["subplots", "サブプロット"],
];

const draw = async (el: HTMLElement, ctx: Ctx) => {
  const ws = ctx.store.get().workspace;
  if (!ws) return void (el.innerHTML = `<div class="empty">ワークスペースを選んでください。</div>`);
  const roots = await loadRoots(ctx);
  const plots = await loadPlots(ctx);
  const mine = collectKeywords(roots);
  const fromPlot = plotKeywords(plots.flatMap((p) => p.rows));
  const on = (kind: "mine" | "plot", k: string) => chosen.kind === kind && chosen.names.includes(k);
  const sheets = chosen.kind === "mine" ? sheetsWith(roots, chosen.names) : chosen.names[0] ? plotSheetsWith(plots, chosen.names[0]) : [];
  const sheetRows = sheets
    .map((p) => `<div class="kws" data-kw-open="${esc(p)}"><span class="ttl">${esc(ctx.titles.get(p) ?? basename(p))}<small>${esc(rel(ws, p))}</small></span></div>`)
    .join("");
  el.innerHTML = `<div class="keywords">
    <div class="sec"><h5>キーワード</h5>${
      mine.map((c) => `<div class="kwr ${on("mine", c.keyword) ? "on" : ""}" data-kw="${esc(c.keyword)}"><span>${esc(c.keyword)}</span><small>${c.count}</small></div>`).join("") ||
      `<div class="empty">右のパネルの「添付」で、シートにキーワードを付けます。</div>`
    }</div>
    ${SOURCES.filter(([k]) => fromPlot[k].length)
      .map(([k, label]) => `<div class="sec"><h5>プロットから：${label}</h5>${fromPlot[k].map((n) => `<div class="kwr ${on("plot", n) ? "on" : ""}" data-kw-plot="${esc(n)}"><span>${esc(n)}</span></div>`).join("")}</div>`)
      .join("")}
    ${chosen.names.length ? `<div class="sec"><h5>${esc(chosen.names.join(" かつ "))} のシート（${sheets.length}）</h5>${sheetRows || `<div class="empty">ありません</div>`}</div>` : ""}
  </div>`;
};

/** A keyword renamed or removed in every root. */
const everywhere = async (ctx: Ctx, f: (m: Root["meta"]) => Root["meta"]) => {
  for (const r of await loadRoots(ctx)) {
    const next = f(r.meta);
    if (JSON.stringify(next) !== JSON.stringify(r.meta)) await putMeta(r.root, next);
  }
  ctx.refresh(["left", "right"]);
};

export const mountKeywords = (ctx: Ctx) => {
  ctx.left.keywords = {
    icon: "tag",
    title: "キーワード",
    render: async (el) => {
      await draw(el, ctx);
      el.onclick = (e) => {
        const t = e.target as HTMLElement;
        const open = t.closest<HTMLElement>("[data-kw-open]")?.dataset.kwOpen;
        if (open) return void ctx.open([open]);
        const k = t.closest<HTMLElement>("[data-kw]")?.dataset.kw;
        const p = t.closest<HTMLElement>("[data-kw-plot]")?.dataset.kwPlot;
        if (k !== undefined) {
          // ⌘ adds to (or takes from) the chosen ones: sheets with all of them
          const names = e.metaKey && chosen.kind === "mine" ? (chosen.names.includes(k) ? chosen.names.filter((x) => x !== k) : [...chosen.names, k]) : chosen.names.length === 1 && chosen.names[0] === k && chosen.kind === "mine" ? [] : [k];
          chosen = { kind: "mine", names };
        } else if (p !== undefined) chosen = { kind: "plot", names: chosen.kind === "plot" && chosen.names[0] === p ? [] : [p] };
        else return;
        ctx.refresh(["left"]);
      };
      el.oncontextmenu = (e) => {
        const row = (e.target as HTMLElement).closest<HTMLElement>("[data-kw]");
        const k = row?.dataset.kw;
        if (!row || k === undefined) return;
        e.preventDefault();
        menu(row, [
          {
            label: "名前を変える",
            icon: icon("pencil", 14),
            run: async () => {
              const to = (await ask("キーワードの新しい名前", k))?.trim();
              if (!to || to === k) return;
              const all = collectKeywords(await loadRoots(ctx));
              if (all.some((c) => c.keyword === to) && !(await confirmDialog(`「${to}」はすでにあります。一つにまとめますか`, "まとめる"))) return;
              await everywhere(ctx, (m) => renameEverywhere(m, k, to));
              chosen = { kind: "mine", names: chosen.names.map((x) => (x === k ? to : x)) };
            },
          },
          {
            label: "すべてのシートから外す",
            icon: icon("x", 14),
            run: async () => {
              if (!(await confirmDialog(`「${k}」をすべてのシートから外しますか`, "外す"))) return;
              await everywhere(ctx, (m) => removeEverywhere(m, k));
              chosen = { kind: "mine", names: chosen.names.filter((x) => x !== k) };
            },
          },
        ]);
      };
    },
  };
  addCommands(ctx.commands, {
    id: "view.left.keywords",
    label: "サイドバー：キーワード",
    icon: "tag",
    when: () => true,
    run: (c) => {
      const s = c.store.get();
      if (!(s.showLeft && s.left === "keywords")) c.store.dispatch({ type: "left", panel: "keywords" });
    },
  });
};
