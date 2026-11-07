// The plot in the app (docs/adr/0013): in place of the editor, from the ribbon
// and the tree; in its own window; its rows for the right panel and the tree.
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
  let view: { project: string; v: PlotView } | null = null;
  ctx.kindViews.plot = (el, doc, c) => {
    const project = doc.project!;
    const v = mountPlot(el, project, { onOpenFile: (rel) => void c.open([`${project}/${rel}`]) });
    view = { project, v };
    return stubEditor(() => {
      v.destroy();
      if (view?.v === v) view = null;
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
    if (e.payload.from !== me && view?.project === e.payload.project) void view.v.reload();
    void plotRows(e.payload.project).then(() => ctx.refresh(["left", "right"]));
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
};
