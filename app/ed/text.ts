// The document of the editor (docs/adr/0019): an immutable string with the
// start of each line. Positions are UTF-16 units, as the DOM's are.

export type Line = { number: number; from: number; to: number; text: string };

export type Text = {
  readonly length: number;
  readonly lines: number;
  line: (n: number) => Line;
  lineAt: (pos: number) => Line;
  slice: (from: number, to: number) => string;
  replace: (from: number, to: number, insert: string) => Text;
  toString: () => string;
};

const startsOf = (s: string): number[] => {
  const out = [0];
  for (let i = s.indexOf("\n"); i >= 0; i = s.indexOf("\n", i + 1)) out.push(i + 1);
  return out;
};

export const textOf = (s: string): Text => {
  const starts = startsOf(s);
  const line = (n: number): Line => {
    const k = Math.min(Math.max(1, n), starts.length);
    const from = starts[k - 1];
    const to = k < starts.length ? starts[k] - 1 : s.length;
    return { number: k, from, to, text: s.slice(from, to) };
  };
  const lineAt = (pos: number): Line => {
    const p = Math.min(Math.max(0, pos), s.length);
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= p) lo = mid;
      else hi = mid - 1;
    }
    return line(lo + 1);
  };
  return {
    length: s.length,
    lines: starts.length,
    line,
    lineAt,
    slice: (from, to) => s.slice(from, to),
    replace: (from, to, insert) => textOf(s.slice(0, from) + insert + s.slice(to)),
    toString: () => s,
  };
};
