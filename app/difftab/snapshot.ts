import { splitLines, type LineChange } from "../diff.ts";
import { characterSpans } from "./characters.ts";
import type { DiffLine, DiffSpan } from "./text.ts";

export type GutterSnapshot = { base: string | null; text: string; runs: LineChange[]; selected: LineChange[]; line: number };
export type SheetSnapshot = GutterSnapshot & { path: string; workspace: string | null; reloaded?: true };

// The full text is retained even when the middle is too long for character LCS.
export const snapshotCharacterSpans = (before: string, after: string) => characterSpans(before, after, 4_000_000);

const CONTEXT = 3;
const LIMIT = 2000;
type Row = Exclude<DiffLine, { kind: "text" }> | { before?: string; after?: string };

export const snapshotDiff = (base: string | null, text: string, runs: LineChange[], selected: LineChange[]) => {
  const before = splitLines(base ?? "");
  const after = splitLines(text);
  const rows: Row[] = [];
  const selectedRuns = new Set(selected);
  let target = -1;
  let targetEnd = 0;
  for (let i = 0; i < runs.length;) {
    const first = runs[i];
    let end = i + 1;
    while (end < runs.length) {
      const previous = runs[end - 1];
      if (runs[end].afterStart - (previous.afterStart + previous.after.length) > 2 * CONTEXT) break;
      end++;
    }
    const last = runs[end - 1];
    let cursor = Math.max(0, first.afterStart - CONTEXT);
    const afterEnd = Math.min(after.length, last.afterStart + last.after.length + CONTEXT);
    const beforeStart = Math.max(0, first.beforeStart - CONTEXT);
    const beforeEnd = Math.min(before.length, last.beforeStart + last.before.length + CONTEXT);
    rows.push({ kind: "hunk", text: `@@ -${beforeStart + (beforeEnd > beforeStart ? 1 : 0)},${beforeEnd - beforeStart} +${cursor + (afterEnd > cursor ? 1 : 0)},${afterEnd - cursor} @@` });
    const commonUntil = (n: number) => {
      for (; cursor < n; cursor++) rows.push({ before: after[cursor], after: after[cursor] });
    };
    for (; i < end; i++) {
      const run = runs[i];
      commonUntil(run.afterStart);
      const chosen = selectedRuns.has(run);
      if (target < 0 && chosen) target = rows.length;
      for (let n = 0; n < Math.max(run.before.length, run.after.length); n++) rows.push({ before: run.before[n], after: run.after[n] });
      if (chosen) targetEnd = rows.length;
      cursor += run.after.length;
    }
    commonUntil(afterEnd);
    const noBefore = !!base && !base.endsWith("\n") && beforeEnd === before.length;
    const noAfter = !!text && !text.endsWith("\n") && afterEnd === after.length;
    if (noBefore || noAfter) rows.push({ kind: "no-newline", side: noBefore && noAfter ? "both" : noBefore ? "before" : "after" });
  }
  target = Math.max(0, target);
  const previous = rows[target - 1];
  const targetStart = previous && "kind" in previous && previous.kind === "hunk" ? target - 1 : target;
  const targetLength = targetEnd - targetStart;
  const start = targetLength >= LIMIT ? targetStart :
    Math.max(0, Math.min(targetStart - Math.floor((LIMIT - targetLength) / 2), rows.length - LIMIT));
  const lines = rows.slice(start, start + LIMIT).map((row): DiffLine => {
    if ("kind" in row) return row;
    const spans: DiffSpan[] = row.before === undefined ? [{ kind: "added", text: row.after! }]
      : row.after === undefined ? [{ kind: "removed", text: row.before }]
      : snapshotCharacterSpans(row.before, row.after);
    return { kind: "text", spans };
  });
  return { lines, target: target - start, omittedBefore: start, omittedAfter: rows.length - start - lines.length };
};
