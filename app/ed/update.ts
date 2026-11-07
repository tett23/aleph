// What a change means for the drawing (docs/adr/0019): which lines to draw
// again, and where coloured ranges (semantic tokens, diagnostics) go until the
// server sends new ones.
import { mapPos, type ChangeSet } from "./change.ts";
import type { Range } from "./spans.ts";
import type { Text } from "./text.ts";

/** Lines replaced by a change of `before`: `removed` lines from `from` (1-based) became `added` lines. */
export type LineChange = { from: number; removed: number; added: number };

const newlines = (s: string) => {
  let n = 0;
  for (let i = s.indexOf("\n"); i >= 0; i = s.indexOf("\n", i + 1)) n++;
  return n;
};

export const changedLines = (before: Text, c: ChangeSet): LineChange | null => {
  if (!c.parts.length) return null;
  const from = before.lineAt(c.parts[0].from).number;
  const to = before.lineAt(c.parts[c.parts.length - 1].to).number;
  const removed = to - from + 1;
  const added = c.parts.reduce((n, p) => n + newlines(p.insert) - newlines(before.slice(p.from, p.to)), removed);
  return { from, removed, added };
};

/** Ranges moved through a change; a range whose text was all removed is dropped, a zero-width one kept. */
export const mapRanges = (ranges: Range[], c: ChangeSet): Range[] =>
  ranges.flatMap((r) => {
    if (r.from === r.to) {
      const p = mapPos(c, r.from, 1);
      return [{ ...r, from: p, to: p }];
    }
    const from = mapPos(c, r.from, 1);
    const to = mapPos(c, r.to, -1);
    return to > from ? [{ ...r, from, to }] : [];
  });

/** Ranges of the document given to the lines they touch, in each line's own offsets. */
export const linesOfRanges = (doc: Text, ranges: Range[]): Map<number, Range[]> => {
  const out = new Map<number, Range[]>();
  for (const r of ranges) {
    const first = doc.lineAt(r.from).number;
    const last = doc.lineAt(r.to).number;
    for (let n = first; n <= last; n++) {
      const l = doc.line(n);
      const from = Math.max(r.from, l.from) - l.from;
      const to = Math.min(r.to, l.to) - l.from;
      if (to < from || (to === from && r.from !== r.to)) continue;
      const list = out.get(n) ?? [];
      list.push({ ...r, from, to });
      out.set(n, list);
    }
  }
  return out;
};
