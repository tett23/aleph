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

/** Other nonoverlapping, literal occurrences of the selection (docs/adr/0091). */
export const selectionMatches = (text: string, range: Match): Match[] => {
  const selected = text.slice(range.from, range.to);
  if (!selected) return [];
  const matches: Match[] = [];
  let start = 0;
  while (matches.length < LIMIT) {
    const from = text.indexOf(selected, start);
    if (from < 0) break;
    const to = from + selected.length;
    if (from !== range.from || to !== range.to) matches.push({ from, to });
    start = to;
  }
  return matches;
};
