import type { GitDiffSpan } from "../git-ipc.ts";

// Find where the deterministic LCS path first reaches the middle row. Each
// cell follows the same successor as the full table and carries its crossing.
const crossing = (a: string[], b: string[], start: number, end: number, left: number, right: number, mid: number) => {
  const width = right - left;
  const scores = new Uint32Array(width + 1);
  const columns = new Uint32Array(width + 1);
  for (let i = end - 1; i >= start; i--) {
    let diagonalScore = 0;
    let diagonalColumn = columns[width];
    if (i <= mid) columns[width] = right;
    for (let j = width - 1; j >= 0; j--) {
      const downScore = scores[j];
      const downColumn = columns[j];
      if (a[i] === b[left + j]) {
        scores[j] = diagonalScore + 1;
        columns[j] = diagonalColumn;
      } else if (scores[j + 1] > downScore) {
        scores[j] = scores[j + 1];
        columns[j] = columns[j + 1];
      }
      if (i === mid) columns[j] = left + j;
      diagonalScore = downScore;
      diagonalColumn = downColumn;
    }
  }
  return columns[0];
};

export const characterSpans = (before: string, after: string): GitDiffSpan[] => {
  const a = Array.from(before);
  const b = Array.from(after);
  const spans: GitDiffSpan[] = [];
  const emit = (kind: GitDiffSpan["kind"], text: string) => {
    if (!text) return;
    const last = spans.at(-1);
    if (last?.kind === kind) last.text += text;
    else spans.push({ kind, text });
  };
  const compare = (start: number, end: number, left: number, right: number) => {
    while (start < end && left < right && a[start] === b[left]) {
      emit("same", a[start]);
      start++;
      left++;
    }
    if (left === right) return emit("removed", a.slice(start, end).join(""));
    if (start === end) return emit("added", b.slice(left, right).join(""));
    if (end - start === 1) {
      let j = left;
      while (j < right && a[start] !== b[j]) j++;
      if (j === right) {
        emit("removed", a[start]);
        emit("added", b.slice(left, right).join(""));
        return;
      }
      emit("added", b.slice(left, j).join(""));
      emit("same", a[start]);
      return emit("added", b.slice(j + 1, right).join(""));
    }
    const mid = Math.floor((start + end) / 2);
    const col = crossing(a, b, start, end, left, right, mid);
    compare(start, mid, left, col);
    compare(mid, end, col, right);
  };
  let end = a.length;
  let right = b.length;
  let prefix = 0;
  while (prefix < end && prefix < right && a[prefix] === b[prefix]) prefix++;
  while (end > prefix && right > prefix && a[end - 1] === b[right - 1]) {
    end--;
    right--;
  }
  emit("same", a.slice(0, prefix).join(""));
  compare(prefix, end, prefix, right);
  emit("same", a.slice(end).join(""));
  return spans;
};
