// Small statistics of the benchmark

const sorted = (xs: readonly number[]) => xs.slice().sort((a, b) => a - b);

export const median = (xs: readonly number[]): number => {
  if (xs.length === 0) return NaN;
  const s = sorted(xs);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// The nearest-rank percentile: the smallest value with at least p% of the
// values at or below it
export const percentile = (xs: readonly number[], p: number): number => {
  if (xs.length === 0) return NaN;
  const s = sorted(xs);
  return s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)];
};

export const p95 = (xs: readonly number[]) => percentile(xs, 95);
