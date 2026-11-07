// Finding and replacing in the editor's search panel (docs/adr/0019).

export type Query = { search: string; regexp?: boolean; caseSensitive?: boolean };
export type Match = { from: number; to: number };

const LIMIT = 10000;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const regexpOf = (q: Query): RegExp | null => {
  if (!q.search) return null;
  try {
    return new RegExp(q.regexp ? q.search : escapeRe(q.search), q.caseSensitive ? "gu" : "giu");
  } catch {
    return null;
  }
};

/** Every match in the text (up to a limit), empty matches left out. */
export const findAll = (text: string, q: Query): Match[] => {
  const re = regexpOf(q);
  if (!re) return [];
  const out: Match[] = [];
  for (const m of text.matchAll(re)) {
    if (!m[0].length) continue;
    out.push({ from: m.index, to: m.index + m[0].length });
    if (out.length >= LIMIT) break;
  }
  return out;
};

/** The match after `pos` (dir 1) or before it (dir -1), wrapping around. */
export const nearest = (matches: Match[], pos: number, dir: 1 | -1): Match | null => {
  if (!matches.length) return null;
  if (dir > 0) return matches.find((m) => m.from >= pos) ?? matches[0];
  return [...matches].reverse().find((m) => m.to <= pos && m.from < pos) ?? matches[matches.length - 1];
};

/** What a match is replaced with: groups filled in for a regexp, the text as it is otherwise. */
export const replacementOf = (matched: string, q: Query, replace: string): string => {
  if (!q.regexp) return replace;
  const re = regexpOf(q);
  if (!re) return replace;
  return matched.replace(new RegExp(re.source, re.flags.replace("g", "")), replace);
};

/** Other occurrences of a short selection (as CodeMirror's highlightSelectionMatches marks them): none for long, multi-line or blank ones. */
export const selectionMatches = (text: string, range: { from: number; to: number }): Match[] => {
  const t = text.slice(range.from, range.to);
  if (!t || t.length > 200 || t.includes("\n") || !t.trim()) return [];
  return findAll(text, { search: t, caseSensitive: true }).filter((m) => m.from !== range.from);
};
