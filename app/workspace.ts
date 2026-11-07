// Workspaces and the Golem projects in them (docs/adr/0004). Pure functions over the tree.
import type { Entry } from "./api.ts";
import { ext } from "./path.ts";
import type { Grid } from "./store.ts";

export const TEXT_KINDS = ["gm", "emet", "md", "txt", "toml", "csv", "tsv", "svg", "mmd"];
export const IMAGE_KINDS = ["png", "jpg", "jpeg", "gif", "webp"];
/** Every kind Aleph opens (docs/adr/0002). */
export const OPEN_KINDS = [...TEXT_KINDS, "pdf", ...IMAGE_KINDS];

export const kindOf = (path: string) => {
  const e = ext(path);
  return e === "mermaid" ? "mmd" : e;
};

export const isProject = (e: Entry) => e.dir && e.children.some((c) => !c.dir && c.name === "manifest.toml");

/** The projects in a tree. A project inside a project is not one (its manifest is ignored). */
export const collectProjects = (entries: Entry[]): string[] =>
  entries.flatMap((e) => (!e.dir ? [] : isProject(e) ? [e.path] : collectProjects(e.children)));

/** The project that contains a path, if any. */
export const projectOf = (path: string, projects: string[]) =>
  projects.filter((p) => path.startsWith(p + "/")).sort((a, b) => b.length - a.length)[0] ?? null;

/** The workspace that contains a path, if any. */
export const workspaceOf = (path: string, workspaces: string[]) =>
  workspaces.filter((w) => path === w || path.startsWith(w + "/")).sort((a, b) => b.length - a.length)[0] ?? null;

export const flatten = (entries: Entry[]): Entry[] => entries.flatMap((e) => (e.dir ? flatten(e.children) : [e]));

/** Whether the tree shows a file: the kinds Aleph opens. */
export const shownFile = (e: Entry) => !e.dir && OPEN_KINDS.includes(kindOf(e.path));

export type Row =
  | { t: "dir"; entry: Entry; depth: number; project: boolean }
  | { t: "file"; entry: Entry; depth: number; project: string | null; plot: boolean };

/**
 * The rows of the tree. In a project, the chapters come first in the manifest's order,
 * then the rest; plot.csv is the plot. `chaptersOf` gives a project's chapter paths.
 */
export const treeRows = (entries: Entry[], expanded: Set<string>, chaptersOf: (project: string) => string[], depth = 0, project: string | null = null): Row[] =>
  entries.flatMap((e): Row[] => {
    if (!e.dir) return shownFile(e) ? [{ t: "file", entry: e, depth, project, plot: project !== null && e.path === `${project}/plot.csv` }] : [];
    const proj = project === null && isProject(e);
    const head: Row = { t: "dir", entry: e, depth, project: proj };
    if (!expanded.has(e.path)) return [head];
    if (!proj) return [head, ...treeRows(e.children, expanded, chaptersOf, depth + 1, project)];
    const chapters = chaptersOf(e.path);
    const byPath = new Map(flatten(e.children).map((c) => [c.path, c]));
    const chapterRows: Row[] = chapters.flatMap((p) => {
      const c = byPath.get(p);
      return c ? [{ t: "file", entry: c, depth: depth + 1, project: e.path, plot: false }] : [];
    });
    const strip = (es: Entry[]): Entry[] =>
      es.filter((c) => !chapters.includes(c.path)).map((c) => (c.dir ? { ...c, children: strip(c.children) } : c));
    const rest = strip(e.children)
      .filter((c) => !(c.dir && c.children.length === 0 && c.name === "chapters"))
      .sort((a, b) => Number(b.name === "plot.csv") - Number(a.name === "plot.csv"));
    return [head, ...chapterRows, ...treeRows(rest, expanded, chaptersOf, depth + 1, e.path)];
  });

/** The text of a heading line without Golem's commands, expressions and comments (rough). */
const plainHeading = (s: string) =>
  s
    .replace(/%%.*?%%/g, "")
    .replace(/\[=[^\]]*\]/g, "")
    .replace(/\[[a-z][\w.-]*:\s*([^\]|]*)(?:\|[^\]]*)?\]/g, "$1")
    .replace(/\[[a-z][\w.-]*[^\]]*\]/g, "")
    .replace(/\\(.)/g, "$1")
    .trim();

/** The first heading of a gm or md sheet, or null. */
export const titleOf = (kind: string, text: string): string | null => {
  if (kind !== "gm" && kind !== "md") return null;
  let fence = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) continue;
    const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (m) return (kind === "gm" ? plainHeading(m[1]) : m[1]) || null;
  }
  return null;
};

/** The grid of style.toml: characters per line and lines per page in [page.grid], the direction in [page]. */
export const readGrid = (style: string): Grid => {
  const section = (name: string) => {
    const m = new RegExp(`^\\[${name.replace(".", "\\.")}\\]\\s*$([\\s\\S]*?)(?=^\\[|$(?![\\s\\S]))`, "m").exec(style);
    return m ? m[1] : "";
  };
  const num = (body: string, k: string, d: number) => {
    const m = new RegExp(`^\\s*${k}\\s*=\\s*(\\d+)`, "m").exec(body);
    return m ? Number(m[1]) : d;
  };
  const grid = section("page.grid");
  return {
    chars: num(grid, "characters", 40),
    lines: num(grid, "lines", 16),
    vertical: /^\s*writing-mode\s*=\s*"vertical"/m.test(section("page")),
  };
};

/**
 * The chapters selected by a click with shift (the range from the anchor) or
 * cmd (toggle one), among the gm rows in the tree's order (docs/adr/0006).
 */
export const selectChapters = (gmRows: string[], current: string[], anchor: string | null, clicked: string, mode: "range" | "toggle"): string[] => {
  if (!anchor || !gmRows.includes(anchor) || !gmRows.includes(clicked)) return [clicked];
  if (mode === "range") {
    const [a, b] = [gmRows.indexOf(anchor), gmRows.indexOf(clicked)].sort((x, y) => x - y);
    return gmRows.slice(a, b + 1);
  }
  const base = current.length ? current : [anchor];
  const next = base.includes(clicked) ? base.filter((p) => p !== clicked) : [...base, clicked];
  return gmRows.filter((p) => next.includes(p));
};
