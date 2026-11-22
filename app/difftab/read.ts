// Reading the diff tab's list (docs/adr/0088): `git status` of the workspace, its place in the
// repository, and each file's `git diff` made into the files shown, with what kind of change each is.
// Pure: no DOM and no Tauri here, so that node --test can run it.

import { readDiffText, type DiffLine, type DiffOutput } from "./text.ts";

/** The kinds of change, from the two letters of `git status` (XY). */
export type ChangeKind = "競合" | "追加" | "削除" | "名前の変更" | "変更";

/** One entry of `git status --porcelain=v1 -z`, with its paths from the workspace. */
export type DiffEntry = { xy: string; path: string; from?: string };

/** One file of the list: what is shown for it. */
export type DiffFile = {
  /** The path from the workspace, and the path before for a rename. */
  path: string;
  from?: string;
  kind: ChangeKind;
  added: number;
  removed: number;
  /** The diff's lines (from the first @@), a binary file, a folder (a nested repository), or no difference. */
  body: "lines" | "binary" | "folder" | "empty";
  lines: DiffLine[];
  /** The lines past MAX_LINES. */
  moreLines: number;
  /** Whether its name opens the sheet: not for a deleted file nor a folder. */
  openable: boolean;
};

/** The lines shown for one file, @@ lines included (I7). */
export const MAX_LINES = 2000;
/** The files listed (I7). */
export const MAX_FILES = 200;

/** The table of the ADR, from the top; the first row that matches. */
export const changeKind = (xy: string): ChangeKind => {
  const [x, y] = [xy[0], xy[1]];
  const either = (c: string) => x === c || y === c;
  if (either("U") || xy === "AA" || xy === "DD") return "競合";
  if (xy === "??" || either("A")) return "追加";
  if (either("D")) return "削除";
  if (either("R")) return "名前の変更";
  return "変更";
};

/** A path from the repository's root made a path from the workspace (`prefix` is `git rev-parse --show-prefix`). */
const fromWorkspace = (path: string, prefix: string) => (prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path);

/** `git status --porcelain=v1 -z -uall -- .`, in its order: a rename (or a copy) is followed by the path before. */
export const readStatus = (z: string, prefix: string): DiffEntry[] => {
  const parts = z.split("\0");
  const out: DiffEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.length < 4) continue;
    const xy = p.slice(0, 2);
    const e: DiffEntry = { xy, path: fromWorkspace(p.slice(3), prefix) };
    if (xy[0] === "R" || xy[0] === "C") e.from = fromWorkspace(parts[++i] ?? "", prefix);
    out.push(e);
  }
  return out;
};

const isFolder = (e: DiffEntry) => e.path.endsWith("/");

/**
 * The arguments of git that read one file's diff, run in the workspace; null for a folder. A tracked file
 * against HEAD, a rename with the path before, an untracked file (or any file with no commit yet) against
 * /dev/null. Pathspecs are literal, so that `[` and `*` in a name match that file alone; `--no-index`
 * takes paths, not pathspecs, so its path is given as it is.
 */
export const diffArgs = (e: DiffEntry, hasHead: boolean): string[] | null => {
  if (isFolder(e)) return null;
  if (!hasHead || e.xy === "??") return ["diff", "--no-index", "--", "/dev/null", e.path];
  if (e.from !== undefined && changeKind(e.xy) === "名前の変更") return ["diff", "HEAD", "-M", "--", `:(literal)${e.from}`, `:(literal)${e.path}`];
  return ["diff", "HEAD", "--", `:(literal)${e.path}`];
};

/** The restored display lines and the ordinary patch's full line counts. */
export const readDiff = (ordinary: string, porcelain: string) =>
  readDiffText({ ordinary, porcelain }, MAX_LINES);

/**
 * The diff tab's list (I6, I7): the files of `git status` in its order (at most MAX_FILES), each with its
 * path from the workspace, its kind of change, its counts and the lines shown. `diffs` holds each file's
 * diff output by its path from the workspace; a file without one shows no difference.
 */
export const diffFiles = (z: string, prefix: string, diffs: ReadonlyMap<string, DiffOutput>): { files: DiffFile[]; moreFiles: number } => {
  const entries = readStatus(z, prefix);
  const files = entries.slice(0, MAX_FILES).map((e): DiffFile => {
    const kind = changeKind(e.xy);
    const openable = kind !== "削除" && e.xy[1] !== "D" && !isFolder(e);
    const base = { path: e.path, ...(e.from !== undefined ? { from: e.from } : {}), kind, openable };
    if (isFolder(e)) return { ...base, body: "folder", lines: [], moreLines: 0, added: 0, removed: 0 };
    const { ordinary, porcelain } = diffs.get(e.path) ?? { ordinary: "", porcelain: "" };
    return { ...base, ...readDiff(ordinary, porcelain) };
  });
  return { files, moreFiles: Math.max(0, entries.length - MAX_FILES) };
};
