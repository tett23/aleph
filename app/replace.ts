// Replacing across the workspace (docs/adr/0032): the pieces of the search
// panel that need no DOM. The replacing itself is in Rust (replace.rs).
import { esc } from "./esc.ts";
import { projectOf } from "./workspace.ts";

/** A hit's line with the match struck out and its replacement in strong, by characters. */
export const afterHtml = (text: string, start: number, end: number, after: string) => {
  const cs = [...text];
  return `${esc(cs.slice(0, start).join(""))}<del>${esc(cs.slice(start, end).join(""))}</del><strong>${esc(after)}</strong>${esc(cs.slice(end).join(""))}`;
};

/** The question before replacing; `partial` when the search stopped at its limit (every match is replaced). */
export const confirmText = (files: number, matches: number, git: boolean, partial = false) =>
  `${files} ファイル${partial ? "以上" : ""}の ${matches} 件${partial ? "以上" : ""}を置換しますか。${git ? "Git の変更から戻せます。" : "ディスクの上のファイルの置換は元に戻せません。"}`;

export type Spot = { line: number; column: number; matched: string };

/** The chosen hits (by index) grouped by path, as the Rust side takes them. */
export const spotsOf = (hits: (Spot & { path: string })[], chosen: Set<number>): Record<string, Spot[]> => {
  const out: Record<string, Spot[]> = {};
  hits.forEach((h, i) => {
    if (chosen.has(i)) (out[h.path] ??= []).push({ line: h.line, column: h.column, matched: h.matched });
  });
  return out;
};

/** The projects whose lint and preflight run after a replace: those holding a replaced .gm, .emet, .toml or .json (docs/adr/0041). */
export const projectsTouched = (paths: string[], projects: string[]): string[] =>
  [...new Set(paths.filter((p) => /\.(gm|emet|toml|json)$/.test(p)).flatMap((p) => projectOf(p, projects) ?? []))];
