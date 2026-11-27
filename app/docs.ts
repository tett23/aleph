// Loading sheets and opening them (docs/adr/0004).
import { api } from "./api.ts";
import type { At, Ctx, OpenOpts, SaveOptions } from "./ctx.ts";
import { allDocs, canOpenFromDiff, type DiffDestination, type Doc, type Grid, type State } from "./store.ts";
import { IMAGE_KINDS, kindOf, projectOf, readGrid, workspaceOf } from "./workspace.ts";

const grids = new Map<string, Grid>();

/** The grid of a project's style.toml; cached until the style is saved. */
export const gridOf = async (project: string | null): Promise<Grid> => {
  if (!project) return { chars: 40, lines: 16, vertical: false };
  if (!grids.has(project)) grids.set(project, readGrid(await api.readText(`${project}/style.toml`).catch(() => "")));
  return grids.get(project)!;
};

export const forgetGrid = (project: string) => grids.delete(project);

/**
 * The SHA-256 of the bytes each open PDF or image sheet shows, taken when it is loaded and drawn again.
 * A moved file is rebound only when its bytes still have it (docs/adr/0108 I4).
 */
const shown = new Map<string, string>();

export const fingerprintOf = async (path: string): Promise<string | null> => {
  try {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await api.readBytes(path)));
    return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
};

export const noteShown = async (path: string) => {
  const f = await fingerprintOf(path);
  if (f) shown.set(path, f);
  else shown.delete(path);
};

export const shownOf = (path: string) => shown.get(path);

export const moveShown = (from: string, to: string) => {
  const f = shown.get(from);
  shown.delete(from);
  if (f) shown.set(to, f);
};

export const loadDoc = async (path: string, ctx: Ctx): Promise<Doc> => {
  const kind = kindOf(path);
  const workspace = workspaceOf(path, ctx.store.get().workspaces);
  const project = projectOf(path, ctx.projects);
  const binary = kind === "pdf" || IMAGE_KINDS.includes(kind);
  const text = binary ? "" : await api.readText(path);
  if (binary) await noteShown(path);
  return { path, kind, text, saved: text, project, workspace, grid: await gridOf(project) };
};

export const openPaths = async (ctx: Ctx, paths: string[], at?: At, opts?: OpenOpts) => {
  if (paths.length === 1) for (const o of ctx.openers) if (await o(paths[0], ctx, opts)) return;
  const docs = await Promise.all(paths.map((p) => loadDoc(p, ctx)));
  ctx.pendingAt = at ?? null;
  ctx.store.dispatch({ type: "open", docs, newTab: opts?.newTab });
};

/** The destination of a diff request is fixed at click time, before file I/O. */
export const diffDestination = (state: State, sourcePane: number, sourceId: number, path: string, plot: boolean): DiffDestination | null => {
  if (!state.panes[sourcePane]?.tabs.some((tab) => tab.id === sourceId && tab.diff)) return null;
  const existing = state.panes.flatMap((pane, pi) => pane.tabs.flatMap((tab) =>
    (plot ? tab.plot === path.slice(0, -"/plot.csv".length) : tab.open.some((doc) => doc.path === path)) ? [{ pane: pi, id: tab.id }] : []))[0];
  const followed = state.panes.flatMap((pane, pi) => pane.tabs.flatMap((tab) =>
    tab.id === state.followed && tab.open.length && !tab.diff && !tab.preview && !tab.plot ? [{ pane: pi, id: tab.id }] : []))[0];
  const target = existing ?? followed;
  return { sourcePane, sourceId, targetPane: target?.pane ?? (state.panes.length > 1 ? 1 - sourcePane : sourcePane), targetId: target?.id ?? null };
};

/** A diff frame opens only into its captured destination while that frame remains current. */
export const openFromDiff = async (ctx: Ctx, path: string, workspace: string, destination: DiffDestination, newTab: boolean, current: () => boolean): Promise<void> => {
  if (!current() || ctx.store.get().workspace !== workspace || workspaceOf(path, [workspace]) !== workspace) return;
  const project = path.endsWith("/plot.csv") ? path.slice(0, -"/plot.csv".length) : null;
  if (project && ctx.projects.includes(project)) {
    if (current() && ctx.store.get().workspace === workspace) ctx.store.dispatch({ type: "plotFromDiff", project, newTab, destination });
    return;
  }
  const doc = await loadDoc(path, ctx);
  if (!current() || ctx.store.get().workspace !== workspace || !canOpenFromDiff(ctx.store.get(), destination, path)) return;
  ctx.pendingAt = null;
  ctx.store.dispatch({ type: "openFromDiff", docs: [doc], newTab, destination });
};

/** Publish a saved action only after the write succeeds. A declined write has no save event. */
export const saveSheets = async (
  ctx: Pick<Ctx, "store" | "editors">,
  paths: string[] | undefined,
  opts: SaveOptions | undefined,
  write: (doc: Doc, text: string) => Promise<boolean>,
) => {
  const written = new Set<string>();
  for (const doc of allDocs(ctx.store.get())) {
    if (written.has(doc.path) || (paths && !paths.includes(doc.path))) continue;
    const text = ctx.editors.get(doc.path)?.text() ?? doc.text;
    if (text === doc.saved && !opts?.explicit) continue;
    if (!(await write(doc, text))) continue;
    written.add(doc.path);
    ctx.store.dispatch({
      type: "saved", path: doc.path, text,
      pageSave: opts?.pageSave ?? (opts?.explicit ? "explicit" : undefined),
      beforeFormat: opts?.beforeFormat,
    });
  }
  return written;
};
