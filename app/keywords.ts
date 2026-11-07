// Keywords a writer gives to sheets (docs/adr/0028): kept with each sheet's
// metadata in .aleph/notes.json, gathered across the workspace's roots, and
// read from the plot's rows. Pure, so that node --test can run it.
import type { Meta } from "./notes.ts";
import { namesCell } from "./plot/data.ts";

const norm = (s: string) => s.trim().normalize("NFC");

/** The list with a keyword added at its end, unless empty or already there. */
export const addKeyword = (list: string[], kw: string): string[] => {
  const k = norm(kw);
  return !k || list.some((x) => norm(x) === k) ? list : [...list, k];
};

export const removeKeyword = (list: string[], kw: string): string[] => list.filter((x) => norm(x) !== norm(kw));

export type Root = { root: string; meta: Meta };
export type Counted = { keyword: string; count: number };

/** Every keyword of the roots with the number of sheets that have it, by name. */
export const collectKeywords = (roots: Root[]): Counted[] => {
  const n = new Map<string, number>();
  for (const r of roots) for (const m of Object.values(r.meta)) for (const k of new Set((m.keywords ?? []).map(norm))) n.set(k, (n.get(k) ?? 0) + 1);
  return [...n].map(([keyword, count]) => ({ keyword, count })).sort((a, b) => a.keyword.localeCompare(b.keyword, "ja"));
};

type PlotRow = { pov: string; characters: string; place: string; subplots: string };
export type PlotKeywords = { pov: string[]; characters: string[]; place: string[]; subplots: string[] };

/** The plot's names by where they come from, each once, in the rows' order. */
export const plotKeywords = (rows: PlotRow[]): PlotKeywords => {
  const of = (f: keyof PlotRow) => [...new Set(rows.flatMap((r) => namesCell(r[f])))];
  return { pov: of("pov"), characters: of("characters"), place: of("place"), subplots: of("subplots") };
};

/** The sheets (absolute paths, sorted) that have every one of the keywords. */
export const sheetsWith = (roots: Root[], kws: string[]): string[] => {
  if (!kws.length) return [];
  const want = kws.map(norm);
  return roots
    .flatMap((r) => Object.entries(r.meta).flatMap(([key, m]) => (want.every((k) => (m.keywords ?? []).some((x) => norm(x) === k)) ? [`${r.root}/${key}`] : [])))
    .sort();
};

const mapKeywords = (m: Meta, f: (list: string[]) => string[]): Meta =>
  Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.keywords ? { ...v, keywords: f(v.keywords) } : v]));

/** A keyword renamed in every sheet; where the new name is there already, the two become one. */
export const renameEverywhere = (m: Meta, from: string, to: string): Meta =>
  mapKeywords(m, (list) => (list.some((x) => norm(x) === norm(from)) ? list.reduce((acc: string[], x) => addKeyword(acc, norm(x) === norm(from) ? to : x), []) : list));

export const removeEverywhere = (m: Meta, kw: string): Meta => mapKeywords(m, (list) => removeKeyword(list, kw));

/** The keywords starting with what was typed, the most used first. */
export const suggest = (all: Counted[], typed: string): string[] =>
  all
    .filter((c) => c.keyword.startsWith(norm(typed)))
    .sort((a, b) => b.count - a.count || a.keyword.localeCompare(b.keyword, "ja"))
    .map((c) => c.keyword);

/** The sheets whose plot rows name a keyword in any of the name columns. */
export const plotSheetsWith = (plots: { project: string; rows: (PlotRow & { file: string })[] }[], kw: string): string[] =>
  [
    ...new Set(
      plots.flatMap((p) =>
        p.rows.filter((r) => r.file.trim() && (["pov", "characters", "place", "subplots"] as const).some((f) => namesCell(r[f]).includes(norm(kw)))).map((r) => `${p.project}/${r.file.trim()}`),
      ),
    ),
  ].sort();
