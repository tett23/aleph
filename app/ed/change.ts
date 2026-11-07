// Changes to a document (docs/adr/0019): replacements against the original
// text, sorted and not overlapping. They apply, map positions, invert and compose.
import type { Text } from "./text.ts";

export type Replace = { from: number; to?: number; insert: string };
export type Part = { from: number; to: number; insert: string };
export type ChangeSet = { length: number; parts: Part[] };

export const changeSet = (rs: Replace[], length: number): ChangeSet => {
  const parts = rs.map((r) => ({ from: r.from, to: r.to ?? r.from, insert: r.insert })).sort((a, b) => a.from - b.from || a.to - b.to);
  parts.forEach((p, i) => {
    if (p.from < 0 || p.to < p.from || p.to > length) throw new RangeError(`change ${p.from}-${p.to} outside 0-${length}`);
    if (i > 0 && p.from < parts[i - 1].to) throw new RangeError("overlapping changes");
  });
  return { length, parts: parts.filter((p) => p.from !== p.to || p.insert) };
};

export const emptyChanges = (length: number): ChangeSet => ({ length, parts: [] });

export const applyChanges = (doc: Text, c: ChangeSet): Text => {
  const s = doc.toString();
  let out = "";
  let at = 0;
  for (const p of c.parts) {
    out += s.slice(at, p.from) + p.insert;
    at = p.to;
  }
  return doc.replace(0, doc.length, out + s.slice(at));
};

/** The length after the change. */
export const newLength = (c: ChangeSet) => c.parts.reduce((n, p) => n + p.insert.length - (p.to - p.from), c.length);

/**
 * A position of the original text in the changed text. An insertion exactly at
 * the position puts it after the insertion (assoc 1) or before (-1); a position
 * inside a replaced range goes to the end of the replacement.
 */
export const mapPos = (c: ChangeSet, pos: number, assoc: 1 | -1 = 1): number => {
  let delta = 0;
  for (const p of c.parts) {
    if (p.from > pos || (p.from === pos && p.to === pos && assoc < 0)) break;
    if (p.to > pos || (p.from === pos && p.to === pos)) return p.from + delta + p.insert.length;
    delta += p.insert.length - (p.to - p.from);
  }
  return pos + delta;
};

/** The change that turns the changed text back into `doc`. */
export const invertChanges = (c: ChangeSet, doc: Text): ChangeSet => {
  let delta = 0;
  const parts = c.parts.map((p) => {
    const from = p.from + delta;
    delta += p.insert.length - (p.to - p.from);
    return { from, to: from + p.insert.length, insert: doc.slice(p.from, p.to) };
  });
  return { length: newLength(c), parts };
};

/** `a` then `b` as one change of `doc` (the region between the first and last difference). */
export const composeChanges = (a: ChangeSet, b: ChangeSet, doc: Text): ChangeSet => {
  const before = doc.toString();
  const after = applyChanges(applyChanges(doc, a), b).toString();
  let head = 0;
  const max = Math.min(before.length, after.length);
  while (head < max && before[head] === after[head]) head++;
  let tail = 0;
  while (tail < max - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  if (head === before.length && head === after.length) return emptyChanges(before.length);
  return changeSet([{ from: head, to: before.length - tail, insert: after.slice(head, after.length - tail) }], before.length);
};
