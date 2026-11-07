// Fuzzy matching for the ⌘P box (docs/adr/0022, docs/adr/0023): the query's
// characters must appear in the target in order; consecutive characters, word
// starts and the file name part score higher, gaps score lower.

export type FuzzyMatch = { score: number; positions: number[] };

const SEPARATORS = new Set(["/", "-", "_", ".", " "]);

/** Code points of a string with their UTF-16 offsets. */
const points = (s: string) => {
  const out: { ch: string; at: number }[] = [];
  for (let i = 0; i < s.length; ) {
    const ch = String.fromCodePoint(s.codePointAt(i)!);
    out.push({ ch, at: i });
    i += ch.length;
  }
  return out;
};

export const fuzzy = (query: string, target: string): FuzzyMatch | null => {
  const q = points(query.toLowerCase());
  if (!q.length) return { score: 0, positions: [] };
  const t = points(target);
  const lower = t.map((p) => p.ch.toLowerCase());
  const fileStart = target.lastIndexOf("/") + 1;
  const wordStart = (k: number) =>
    k === 0 || SEPARATORS.has(t[k - 1].ch) || (/\p{Lu}/u.test(t[k].ch) && /\p{Ll}/u.test(t[k - 1].ch));
  // for each query character, prefer the next word start before the next plain occurrence
  const positions: number[] = [];
  const picked: number[] = [];
  let k = 0;
  for (const c of q) {
    let found = -1;
    let start = -1;
    for (let j = k; j < t.length; j++) {
      if (lower[j] !== c.ch) continue;
      if (found < 0) found = j;
      if (wordStart(j) || (picked.length && j === picked[picked.length - 1] + 1)) {
        start = j;
        break;
      }
    }
    const j = start >= 0 ? start : found;
    if (j < 0) return null;
    picked.push(j);
    positions.push(t[j].at);
    k = j + 1;
  }
  let score = 0;
  picked.forEach((j, i) => {
    score += 1;
    if (i > 0 && j === picked[i - 1] + 1) score += 10;
    else if (i > 0) score -= Math.min(5, j - picked[i - 1] - 1);
    if (wordStart(j)) score += 8;
    if (t[j].at >= fileStart && fileStart > 0) score += 4;
  });
  return { score, positions };
};
