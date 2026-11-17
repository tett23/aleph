// Applying the assistant's edits to a text (docs/adr/0081, I1 and I2).
// An edit is a find that appears exactly once in the target and the text that
// replaces it. Every find is placed in the text before any edit; the ranges of
// two finds must not overlap, but may touch.

export type Edit = { find: string; replace: string };
export type Applied = { ok: true; text: string } | { ok: false; reason: string };
// What the request was about: the whole sheet, or the text of the selection
// when the request was made
export type Scope = { kind: "sheet" } | { kind: "selection"; text: string };

// The start of every occurrence of `find` in `text`, overlapping ones included
export const occurrences = (text: string, find: string): number[] =>
  find === "" ? [] : [...text.matchAll(new RegExp(`(?=${find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gu"))].map((m) => m.index);

const shown = (s: string) => JSON.stringify(s.length > 40 ? `${s.slice(0, 40)}…` : s);

const wellFormed = (e: unknown): e is Edit =>
  typeof e === "object" && e !== null && typeof (e as Edit).find === "string" && typeof (e as Edit).replace === "string";

type Placed = { start: number; end: number; replace: string };

const place = (text: string, e: Edit): Placed | string => {
  if (e.find === "") return "find が空です";
  const at = occurrences(text, e.find);
  if (at.length === 0) return `${shown(e.find)} が見つかりません`;
  if (at.length > 1) return `${shown(e.find)} が ${at.length} か所にあります`;
  return { start: at[0], end: at[0] + e.find.length, replace: e.replace };
};

export const applyEdits = (text: string, edits: readonly Edit[]): Applied => {
  const bad = edits.findIndex((e) => !wellFormed(e));
  if (bad >= 0) return { ok: false, reason: `${bad + 1} 番目の案の形が正しくありません` };
  const placed = edits.map((e) => place(text, e));
  const missing = placed.find((p): p is string => typeof p === "string");
  if (missing !== undefined) return { ok: false, reason: missing };
  const sorted = (placed as Placed[]).slice().sort((a, b) => a.start - b.start);
  const overlap = sorted.findIndex((p, i) => i > 0 && p.start < sorted[i - 1].end);
  if (overlap > 0) return { ok: false, reason: "二つの find の範囲が重なっています" };
  const out = sorted.reduce(
    (acc, p) => ({ text: acc.text + text.slice(acc.at, p.start) + p.replace, at: p.end }),
    { text: "", at: 0 },
  );
  return { ok: true, text: out.text + text.slice(out.at) };
};

// Applies the edits to the current text of the sheet. On a selection, the text
// selected at the request must appear exactly once in the sheet now; the finds
// are counted inside it.
export const applyToSheet = (sheet: string, scope: Scope, edits: readonly Edit[]): Applied => {
  if (scope.kind === "sheet") return applyEdits(sheet, edits);
  const at = occurrences(sheet, scope.text);
  if (at.length !== 1)
    return { ok: false, reason: at.length === 0 ? "頼んだときの選択の範囲が、今のシートにありません" : "頼んだときの選択の範囲が、今のシートの何か所にもあります" };
  const inner = applyEdits(scope.text, edits);
  if (!inner.ok) return inner;
  return { ok: true, text: sheet.slice(0, at[0]) + inner.text + sheet.slice(at[0] + scope.text.length) };
};
