// Loading sheets and opening them (docs/adr/0004).
import { api } from "./api.ts";
import type { At, Ctx, OpenOpts, SaveOptions } from "./ctx.ts";
import { allDocs, type Doc, type Grid } from "./store.ts";
import { IMAGE_KINDS, kindOf, projectOf, readGrid, workspaceOf } from "./workspace.ts";

const grids = new Map<string, Grid>();

/** The grid of a project's style.toml; cached until the style is saved. */
export const gridOf = async (project: string | null): Promise<Grid> => {
  if (!project) return { chars: 40, lines: 16, vertical: false };
  if (!grids.has(project)) grids.set(project, readGrid(await api.readText(`${project}/style.toml`).catch(() => "")));
  return grids.get(project)!;
};

export const forgetGrid = (project: string) => grids.delete(project);

export const loadDoc = async (path: string, ctx: Ctx): Promise<Doc> => {
  const kind = kindOf(path);
  const workspace = workspaceOf(path, ctx.store.get().workspaces);
  const project = projectOf(path, ctx.projects);
  const binary = kind === "pdf" || IMAGE_KINDS.includes(kind);
  const text = binary ? "" : await api.readText(path);
  return { path, kind, text, saved: text, project, workspace, grid: await gridOf(project) };
};

export const openPaths = async (ctx: Ctx, paths: string[], at?: At, opts?: OpenOpts) => {
  if (paths.length === 1) for (const o of ctx.openers) if (await o(paths[0], ctx, opts)) return;
  const docs = await Promise.all(paths.map((p) => loadDoc(p, ctx)));
  ctx.pendingAt = at ?? null;
  ctx.store.dispatch({ type: "open", docs, newTab: opts?.newTab });
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
