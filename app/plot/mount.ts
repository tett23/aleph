// The plot in the app (docs/adr/0013): in place of the editor, from the ribbon
// and the tree; in its own window; its rows for the right panel and the tree.
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import { api } from "../api.ts";
import { normalize } from "../config.ts";
import type { Ctx } from "../ctx.ts";
import { stubEditor } from "../editor/stub.ts";
import { dirname } from "../path.ts";
import { applyTheme } from "../theme.ts";
import { setUiState, windowUiState } from "../uistate.ts";
import { parsePlot, type PlotRow } from "./data.ts";
import { mountPlot, type PlotView } from "./view.ts";

const cache = new Map<string, PlotRow[]>();

/** A project's plot rows, read once until the plot is saved. */
export const plotRows = async (project: string): Promise<PlotRow[]> => {
  if (!cache.has(project)) cache.set(project, parsePlot(await api.readText(`${project}/plot.csv`).catch(() => "")).rows);
  return cache.get(project)!;
};

/** Plot rows already read, without waiting (null when not read yet). */
export const plotRowsNow = (project: string) => cache.get(project) ?? null;

export const mountPlotFeature = (ctx: Ctx) => {
  const views = new Set<{ project: string; v: PlotView }>();
  ctx.kindViews.plot = (el, doc, c) => {
    const active = { project: doc.project!, v: null as unknown as PlotView };
    active.v = mountPlot(el, active.project, { onOpenFile: (rel) => void c.open([`${active.project}/${rel}`]) });
    views.add(active);
    return stubEditor(() => {
      active.v.destroy();
      views.delete(active);
    });
  };
  // plot.csv of a project opens as the plot, not as text
  ctx.openers.push((path, c, opts) => {
    const project = dirname(path);
    if (!path.endsWith("/plot.csv") || !c.projects.includes(project)) return false;
    c.store.dispatch({ type: "plot", project, newTab: opts?.newTab });
    return true;
  });
  // a save here or in a plot window: read the rows again; the other view reloads
  const me = getCurrentWindow().label;
  void listen<{ project: string; from: string }>("aleph:plot-saved", (e) => {
    cache.delete(e.payload.project);
    if (e.payload.from !== me) for (const active of views) if (active.project === e.payload.project) void active.v.reload();
    void plotRows(e.payload.project).then(() => ctx.refresh(["left", "right"]));
  });
  ctx.beforeRename.push(async (from) => {
    if (!ctx.projects.some((project) => project === from || project.startsWith(`${from}/`))) return;
    await Promise.all([...views].filter((active) => active.project === from || active.project.startsWith(`${from}/`)).map((active) => active.v.flush()));
    const labels = new Set((await getAllWebviewWindows()).map((window) => window.label).filter((label) => label.startsWith("plot-")));
    if (!labels.size) return;
    const request = `${me}-${Date.now()}-${Math.random()}`;
    const received = new Set<string>();
    let done!: () => void;
    const replies = new Promise<void>((resolve) => { done = resolve; });
    const off = await listen<{ request: string; label: string }>("aleph:plot-flushed", (event) => {
      if (event.payload.request !== request || !labels.has(event.payload.label)) return;
      received.add(event.payload.label);
      if (received.size === labels.size) done();
    });
    try {
      await emit("aleph:flush-plots", { request, from });
      await Promise.race([
        replies,
        new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error("プロットの保存が終わりませんでした")), 5000)),
      ]);
    } finally {
      off();
    }
  });
  ctx.onRename.push((from, to) => {
    const projects = ctx.projects.filter((project) => project === from || project.startsWith(`${from}/`));
    for (const project of projects) {
      const target = to + project.slice(from.length);
      const rows = cache.get(project);
      if (rows) cache.set(target, rows);
      cache.delete(project);
      for (const active of views) if (active.project === project) {
        active.project = target;
        active.v.setProject(target);
      }
      void emit("aleph:project-renamed", { from: project, to: target }).catch(() => {});
    }
  });
};

/** The plot's own window (index.html?view=plot&project=…). */
export const startPlotWindow = async (project: string) => {
  const config = normalize(JSON.parse(await api.configLoad().catch(() => "{}")));
  applyTheme(config);
  setUiState(windowUiState(config.ui, (part) => void emit("aleph:ui", part)));
  const app = document.getElementById("app")!;
  app.innerHTML = `<div class="pwin plotwin"><div class="pbody"></div></div>`;
  const v = mountPlot(app.querySelector<HTMLElement>(".pbody")!, project, {
    standalone: true,
    onOpenFile: (rel) => void emit("aleph:open", { path: `${project}/${rel}` }),
  });
  const me = getCurrentWindow().label;
  await listen<{ project: string; from: string }>("aleph:plot-saved", (e) => {
    if (e.payload.from !== me && e.payload.project === project) void v.reload();
  });
  await listen<{ from: string; to: string }>("aleph:project-renamed", (e) => {
    if (e.payload.from !== project) return;
    project = e.payload.to;
    v.setProject(project);
  });
  await listen<{ request: string; from: string }>("aleph:flush-plots", async (e) => {
    if (project === e.payload.from || project.startsWith(`${e.payload.from}/`)) await v.flush();
    await emit("aleph:plot-flushed", { request: e.payload.request, label: me });
  });
};
