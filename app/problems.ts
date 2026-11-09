// The problems panel (docs/adr/0055): the editors' diagnostics and golem's
// check, lint and preflight, grouped by file under the editor.
import type { Diagnostic } from "./diag/parse.ts";
import { rel } from "./path.ts";

/** One diagnostic, from any source; the line and column are 1-based, null when it has no place. */
export type Problem = {
  file: string | null;
  line: number | null;
  col: number | null;
  severity: "error" | "warning" | "info";
  message: string;
  source: string;
  code: string;
};

export type Group = { file: string | null; label: string; items: Problem[] };

export const NOWHERE = "（位置のない診断）";

/** golem's results for a project: notices and infos are "info". */
export const fromGolem = (project: string, source: string, items: Diagnostic[]): Problem[] =>
  items.map((d) => ({
    file: d.span ? `${project}/${d.span.file}` : null,
    line: d.span?.line ?? null,
    col: d.span?.column ?? null,
    severity: d.severity === "error" ? "error" : d.severity === "warning" ? "warning" : "info",
    message: d.message,
    source,
    code: d.code,
  }));

const place = (x: Problem) => `${x.file}\n${x.line}\n${x.col}\n${x.message}`;

/** By file (the focused sheet first, then by path relative to `root`, the placeless last); in a file, by line and column; one per place and message. */
export const groupProblems = (list: Problem[], focused: string | null, root: string | null): Group[] => {
  const seen = new Set<string>();
  const once = list.filter((x) => !seen.has(place(x)) && (seen.add(place(x)), true));
  const files = [...new Set(once.map((x) => x.file))];
  const label = (f: string | null) => (f === null ? NOWHERE : root && f.startsWith(root + "/") ? rel(root, f) : f);
  const rank = (f: string | null) => (f === null ? 2 : f === focused ? 0 : 1);
  return files
    .sort((a, b) => rank(a) - rank(b) || label(a).localeCompare(label(b)))
    .map((f) => ({
      file: f,
      label: label(f),
      items: once.filter((x) => x.file === f).sort((a, b) => (a.line ?? 0) - (b.line ?? 0) || (a.col ?? 0) - (b.col ?? 0)),
    }));
};

export const countProblems = (list: Problem[]) => ({
  errors: list.filter((x) => x.severity === "error").length,
  warnings: list.filter((x) => x.severity === "warning").length,
  others: list.filter((x) => x.severity === "info").length,
});

export const DEFAULT_HEIGHT = 220;
const MIN_HEIGHT = 80;

/** The kept height, between 80 px and 70% of the centre column; the default for a malformed value. */
export const panelHeight = (v: unknown, column: number): number => {
  const h = typeof v === "number" && Number.isFinite(v) ? v : DEFAULT_HEIGHT;
  return Math.max(MIN_HEIGHT, Math.min(h, Math.floor(column * 0.7)));
};
