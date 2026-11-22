// Keep the ranges and the text from the same comparison that supplies the gutter marks.

export type LineMark = "add" | "mod" | "del";
export type LineChange = { beforeStart: number; afterStart: number; before: string[]; after: string[] };
export type LineComparison = { marks: Map<number, LineMark>; runs: LineChange[]; byLine: Map<number, LineChange[]> };

export const splitLines = (text: string) => text === "" ? [] : text.split("\n");

const changeRuns = (before: string[], after: string[]): LineChange[] => {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) {
    beforeEnd--;
    afterEnd--;
  }
  const bn = beforeEnd - start;
  const an = afterEnd - start;
  const range = (b: number, a: number, be: number, ae: number): LineChange => ({
    beforeStart: start + b, afterStart: start + a,
    before: before.slice(start + b, start + be), after: after.slice(start + a, start + ae),
  });
  if (!an || !bn || an * bn > 4_000_000) return an || bn ? [range(0, 0, bn, an)] : [];

  const same = (b: number, a: number) => before[start + b] === after[start + a];
  const stride = bn + 1;
  const dp = new Uint32Array((an + 1) * stride);
  for (let a = an - 1; a >= 0; a--)
    for (let b = bn - 1; b >= 0; b--) {
      const cell = a * stride + b;
      dp[cell] = same(b, a) ? dp[cell + stride + 1] + 1 : Math.max(dp[cell + stride], dp[cell + 1]);
    }

  const runs: LineChange[] = [];
  let a = 0;
  let b = 0;
  let runA = 0;
  let runB = 0;
  const flush = () => {
    if (runA !== a || runB !== b) runs.push(range(runB, runA, b, a));
  };
  while (a < an || b < bn) {
    if (a < an && b < bn && same(b, a)) {
      flush();
      runA = ++a;
      runB = ++b;
    } else if (b < bn && (a >= an || dp[a * stride + b + 1] >= dp[(a + 1) * stride + b])) {
      b++;
    } else {
      a++;
    }
  }
  flush();
  return runs;
};

export const compareLines = (base: string | null | false, now: string): LineComparison => {
  const marks = new Map<number, LineMark>();
  const byLine = new Map<number, LineChange[]>();
  const after = splitLines(now);
  const runs = base === false ? [] : changeRuns(splitLines(base ?? ""), after);
  const mark = (i: number, kind: LineMark, run: LineChange) => {
    if (!marks.has(i)) marks.set(i, kind);
    const existing = byLine.get(i);
    if (existing) existing.push(run);
    else byLine.set(i, [run]);
  };
  for (const run of runs) {
    if (!run.after.length) mark(Math.min(run.afterStart, Math.max(0, after.length - 1)), "del", run);
    else run.after.forEach((_, n) => mark(run.afterStart + n, n < run.before.length ? "mod" : "add", run));
  }
  return { marks, runs, byLine };
};

export const markAtLine = (comparison: LineComparison, line: number) => comparison.byLine.get(line) ?? [];
export const lineMarks = (base: string | null | false, now: string) => compareLines(base, now).marks;
