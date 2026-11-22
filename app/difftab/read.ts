// Reading the diff tab's list (docs/adr/0088): `git status` of the workspace, its place in the
// repository, and each file's `git diff` made into the files shown, with what kind of change each is.
// Pure: no DOM and no Tauri here, so that node --test can run it.

import { readStructuredDiff, type DiffLine } from "./text.ts";
import type { GitDiff, GitStatus } from "../git-ipc.ts";

/** The kinds of change, from the two letters of `git status` (XY). */
export type ChangeKind = "競合" | "追加" | "削除" | "名前の変更" | "変更";


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

export const folderEntry = (entry: GitStatus) => entry.path.endsWith("/");

export const diffFiles = (entries: readonly GitStatus[], diffs: ReadonlyMap<string, GitDiff>) => {
  const files = entries.slice(0, MAX_FILES).map((e): DiffFile => {
    const kind = changeKind(e.xy);
    const openable = kind !== "削除" && e.xy[1] !== "D" && !folderEntry(e);
    const base = { path: e.path, ...(e.from != null ? { from: e.from } : {}), kind, openable };
    const diff = diffs.get(e.path) ?? { body: folderEntry(e) ? "folder" : "empty", hunks: [], added: 0, removed: 0 };
    return { ...base, ...readStructuredDiff(diff, MAX_LINES) };
  });
  return { files, moreFiles: Math.max(0, entries.length - MAX_FILES) };
};
