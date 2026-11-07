// The plot's data (docs/adr/0013): plot.csv's rows, the cells' lists, the
// calendar of the story's times, the stacking of the Gantt chart's bars,
// and the planned characters of a sheet.
import { parseDelimited, writeDelimited } from "../csv.ts";

export const PLOT_COLUMNS = [
  ["scene", "シーン"],
  ["file", "ファイル"],
  ["subplots", "サブプロット"],
  ["pov", "視点人物"],
  ["characters", "登場人物"],
  ["place", "場所"],
  ["must", "書かなくてはいけないこと"],
  ["flavor", "フレーバー"],
  ["target", "予定字数"],
  ["memo", "メモ"],
  ["fragments", "本文の断片"],
  ["start", "開始"],
  ["end", "終了"],
] as const;

export type PlotKey = (typeof PLOT_COLUMNS)[number][0];
export type PlotRow = Record<PlotKey, string> & Record<string, string>;
export type Plot = { rows: PlotRow[]; extras: string[] };

const FIXED: string[] = PLOT_COLUMNS.map(([k]) => k);

/** Whether a name can be given to a new column: not a fixed column's key or label, nor an added one. */
export const freeColumnName = (name: string, extras: string[]) => !!name && !extras.includes(name) && !PLOT_COLUMNS.some(([k, l]) => k === name || l === name);

export const newRow = (extras: string[], init: Partial<PlotRow> = {}): PlotRow =>
  ({ ...Object.fromEntries([...FIXED, ...extras].map((k) => [k, ""])), ...init }) as PlotRow;

export const parsePlot = (csv: string): Plot => {
  const [head, ...body] = parseDelimited(csv, ",");
  if (!head) return { rows: [], extras: [] };
  const names = head.map((h) => h.trim());
  const extras = names.filter((h) => h && !FIXED.includes(h));
  const rows = body
    .filter((r) => r.some((c) => c.trim()))
    .map((r) => newRow(extras, Object.fromEntries(names.map((h, i) => [h, r[i] ?? ""]).filter(([h]) => h))));
  return { rows, extras };
};

export const writePlot = (rows: PlotRow[], extras: string[]): string => {
  const keys = [...FIXED, ...extras];
  return writeDelimited([keys, ...rows.map((r) => keys.map((k) => r[k] ?? ""))], ",");
};

const split = (re: RegExp) => (s: string) =>
  s
    .split(re)
    .map((x) => x.trim())
    .filter(Boolean);

/** subplots, pov, characters, place. */
export const namesCell = split(/\n|;|；|、|,/);
/** must, flavor, fragments. */
export const linesCell = split(/\n|;|；/);

/** A number or a date (YYYY, YYYY-MM, YYYY-MM-DD) as a value to sort by; null for other labels. */
const valueOf = (s: string): number | null => {
  const t = s.trim();
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (!/^\d{4}(-\d{2}(-\d{2})?)?$/.test(t)) return null;
  const d = Date.parse(/^\d{4}$/.test(t) ? `${t}-01-01` : /^\d{4}-\d{2}$/.test(t) ? `${t}-01` : t);
  return Number.isNaN(d) ? null : d;
};

/**
 * The story's times in order: plot-calendar.txt's lines, then the table's
 * times it lacks. Without the file, numbers and dates sort by value when all
 * are such; otherwise the table's order.
 */
export const calendarOf = (rows: PlotRow[], file: string[]): string[] => {
  const seen = [...new Set(rows.flatMap((r) => [r.start.trim(), r.end.trim()]).filter(Boolean))];
  if (file.length) return [...file, ...seen.filter((l) => !file.includes(l))];
  return seen.every((l) => valueOf(l) !== null) ? [...seen].sort((x, y) => valueOf(x)! - valueOf(y)!) : seen;
};

/**
 * The bars of rows on the calendar, as steps [s, e): the end is included, a row
 * without an end takes one step, rows whose start is not on the calendar have none.
 */
export const barsOf = (rows: PlotRow[], indices: number[], calendar: string[]): { i: number; s: number; e: number }[] =>
  indices.flatMap((i) => {
    const r = rows[i];
    const s = calendar.indexOf(r.start.trim());
    if (s < 0) return [];
    const e = r.end.trim() ? calendar.indexOf(r.end.trim()) : s;
    return [{ i, s, e: Math.max(s, e) + 1 }];
  });

/** Bars [s, e) of one lane, in order: each goes to the first row free at its start (bars are taken by their start). */
export const stackLanes = (bars: { s: number; e: number }[]): { rows: number[]; count: number } => {
  const order = bars.map((b, i) => ({ ...b, i })).sort((a, b) => a.s - b.s || a.e - b.e || a.i - b.i);
  const ends: number[] = [];
  const rows: number[] = new Array(bars.length);
  for (const b of order) {
    let r = ends.findIndex((end) => end <= b.s);
    if (r < 0) r = ends.push(0) - 1;
    ends[r] = b.e;
    rows[b.i] = r;
  }
  return { rows, count: Math.max(1, ends.length) };
};

/** Moves the item at `from` to before index `at` (indices of the array before the move). */
export const moveRow = <T>(xs: T[], from: number, at: number): T[] => {
  if (at === from || at === from + 1) return xs;
  const out = [...xs];
  const [x] = out.splice(from, 1);
  out.splice(at > from ? at - 1 : at, 0, x);
  return out;
};

export const insertRow = <T>(xs: T[], at: number, x: T): T[] => [...xs.slice(0, at), x, ...xs.slice(at)];

/** The rows of a sheet: those whose file is the sheet's path from the project's root. */
export const rowsFor = (rows: PlotRow[], project: string, path: string) => rows.filter((r) => r.file.trim() && `${project}/${r.file.trim()}` === path);

/** The sum of the sheet's rows' planned characters; null when none gives one. */
export const targetFor = (rows: PlotRow[], project: string, path: string): number | null => {
  const ts = rowsFor(rows, project, path).map((r) => Number(r.target)).filter((n) => Number.isFinite(n) && n > 0);
  return ts.length ? ts.reduce((a, b) => a + b, 0) : null;
};
