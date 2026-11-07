// Line changes against a base text, for the gutter marks.

export type LineMark = "add" | "mod" | "del";

/** Marks for each 0-based line of `now`: added, modified, or a deletion before it. */
export const lineMarks = (base: string | null, now: string): Map<number, LineMark> => {
  const b = base === null ? [] : base.split("\n");
  const a = now.split("\n");
  const marks = new Map<number, LineMark>();
  if (base === null) {
    a.forEach((_, i) => marks.set(i, "add"));
    return marks;
  }
  // trim the common head and tail, then LCS on the middle
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length;
  let eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) {
    ea--;
    eb--;
  }
  const A = a.slice(s, ea);
  const B = b.slice(s, eb);
  if (A.length * B.length > 4_000_000) {
    A.forEach((_, i) => marks.set(s + i, "mod"));
    return marks;
  }
  const dp: Uint32Array[] = Array.from({ length: A.length + 1 }, () => new Uint32Array(B.length + 1));
  for (let i = A.length - 1; i >= 0; i--)
    for (let j = B.length - 1; j >= 0; j--)
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  let i = 0;
  let j = 0;
  // collect runs of changes
  let addRun: number[] = [];
  let delCount = 0;
  const flush = () => {
    addRun.forEach((k, n) => marks.set(s + k, n < delCount ? "mod" : "add"));
    if (addRun.length === 0 && delCount > 0) marks.set(s + i, "del");
    addRun = [];
    delCount = 0;
  };
  while (i < A.length || j < B.length) {
    if (i < A.length && j < B.length && A[i] === B[j]) {
      flush();
      i++;
      j++;
    } else if (j < B.length && (i >= A.length || dp[i][j + 1] >= dp[i + 1][j])) {
      delCount++;
      j++;
    } else {
      addRun.push(i);
      i++;
    }
  }
  flush();
  return marks;
};
