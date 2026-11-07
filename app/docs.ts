// Loading sheets and opening them (docs/adr/0004).
import { api } from "./api.ts";
import type { At, Ctx } from "./ctx.ts";
import type { Doc, Grid } from "./store.ts";
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

export const openPaths = async (ctx: Ctx, paths: string[], at?: At) => {
  if (paths.length === 1) for (const o of ctx.openers) if (await o(paths[0], ctx)) return;
  const docs = await Promise.all(paths.map((p) => loadDoc(p, ctx)));
  ctx.pendingAt = at ?? null;
  ctx.store.dispatch({ type: "open", docs });
};
