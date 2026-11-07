// What one line is drawn from (docs/adr/0019): coloured ranges in layers
// (tokens, semantic tokens, diagnostics, invisibles) cut at every boundary into
// spans, each with the classes of the ranges over it, in layer order.

export type Range = { from: number; to: number; cls: string };
export type Span = { from: number; to: number; cls: string[] };

export const lineSpans = (text: string, layers: Range[][]): Span[] => {
  const len = text.length;
  const ranges = layers.flatMap((l, li) =>
    l.map((r) => ({ from: Math.max(0, r.from), to: Math.min(len, r.to), cls: r.cls, li })).filter((r) => r.to > r.from),
  );
  const cuts = new Set([0, len]);
  for (const r of ranges) cuts.add(r.from).add(r.to);
  // never cut inside a surrogate pair
  const points = [...cuts].filter((p) => p === 0 || p === len || !(text.charCodeAt(p) >= 0xdc00 && text.charCodeAt(p) <= 0xdfff)).sort((a, b) => a - b);
  if (len === 0) return [{ from: 0, to: 0, cls: [] }];
  const out: Span[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const from = points[i];
    const to = points[i + 1];
    const cls = ranges
      .filter((r) => r.from <= from && r.to >= to)
      .sort((a, b) => a.li - b.li)
      .map((r) => r.cls);
    const last = out[out.length - 1];
    if (last && last.to === from && last.cls.join(" ") === cls.join(" ")) last.to = to;
    else out.push({ from, to, cls });
  }
  return out;
};

/** Spaces, full-width spaces and tabs, shown when the setting is on. */
export const invisibleRanges = (text: string): Range[] => {
  const out: Range[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const cls = c === " " ? "inv-sp" : c === "　" ? "inv-zsp" : c === "\t" ? "inv-tab" : null;
    if (cls) out.push({ from: i, to: i + 1, cls });
  }
  return out;
};

// zero-width, bidi and control characters (what CodeMirror's highlightSpecialChars shows), except tab
const SPECIAL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff\ufff9-\ufffc]/g;

/** Characters that would be invisible or confusing, always marked. */
export const specialRanges = (text: string): Range[] => [...text.matchAll(SPECIAL)].map((m) => ({ from: m.index, to: m.index + 1, cls: "ed-special" }));
