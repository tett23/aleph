// Opening a sheet by its name with ⌘P (docs/adr/0022): the sheets the tree shows
// in the workspace, matched by the title or the path from the workspace's root,
// recent sheets first.
import type { Entry } from "./api.ts";
import { fuzzy } from "./fuzzy.ts";
import { rel } from "./path.ts";
import { flatten, shownFile } from "./workspace.ts";

export type Sheet = { path: string; rel: string; title?: string };
export type Ranked = Sheet & { score: number; field: "title" | "rel"; marks: number[] };

export const LIMIT = 50;
const RECENT_BONUS = 20;

export const rankSheets = (sheets: Sheet[], q: string, recent: string[]): Ranked[] => {
  if (!q) {
    const by = new Map(sheets.map((s) => [s.path, s]));
    return recent.flatMap((p) => {
      const s = by.get(p);
      return s ? [{ ...s, score: 0, field: (s.title ? "title" : "rel") as Ranked["field"], marks: [] }] : [];
    });
  }
  return sheets
    .flatMap((s): Ranked[] => {
      const t = s.title ? fuzzy(q, s.title) : null;
      const r = fuzzy(q, s.rel);
      if (!t && !r) return [];
      const k = recent.indexOf(s.path);
      const bonus = k < 0 ? 0 : RECENT_BONUS * (1 - k / Math.max(1, recent.length));
      const best = t && (!r || t.score >= r.score) ? { score: t.score, field: "title" as const, marks: t.positions } : { score: r!.score, field: "rel" as const, marks: r!.positions };
      return [{ ...s, ...best, score: best.score + bonus }];
    })
    .sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel))
    .slice(0, LIMIT);
};

/** The files the tree shows (docs/adr/0004), with the titles the tree read. */
export const sheetsOf = (entries: Entry[], ws: string, titles: Map<string, string>): Sheet[] =>
  flatten(entries)
    .filter(shownFile)
    .map((e) => ({ path: e.path, rel: rel(ws, e.path), title: titles.get(e.path) }));
