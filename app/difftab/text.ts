import { esc } from "../esc.ts";
import type { GitDiff } from "../git-ipc.ts";
import { characterSpans } from "./characters.ts";

export { characterSpans };
export type { GitDiffSpan as DiffSpan } from "../git-ipc.ts";
import type { GitDiffSpan } from "../git-ipc.ts";

type EndOfFile = "before" | "after" | "both";
export type DiffLine =
  | { kind: "hunk"; text: string }
  | { kind: "text"; spans: GitDiffSpan[] }
  | { kind: "no-newline"; side: EndOfFile };

export const readStructuredDiff = (output: GitDiff, limit: number) => {
  const lines: DiffLine[] = [];
  let count = 0;
  const emit = (line: DiffLine) => { if (count++ < limit) lines.push(line); };
  for (const hunk of output.hunks) {
    emit({ kind: "hunk", text: hunk.heading });
    let before: string[] = [];
    let after: string[] = [];
    let noBefore = false;
    let noAfter = false;
    const flush = () => {
      for (let i = 0; i < Math.max(before.length, after.length); i++) {
        if (count >= limit) { count += Math.max(before.length, after.length) - i; break; }
        emit({ kind: "text", spans: characterSpans(before[i] ?? "", after[i] ?? "") });
      }
      before = [];
      after = [];
    };
    for (const { kind, text } of hunk.lines) {
      if (kind !== "added") noBefore = !text.endsWith("\n");
      if (kind !== "removed") noAfter = !text.endsWith("\n");
      if (kind === "same") {
        flush();
        emit({ kind: "text", spans: [{ kind, text }] });
      } else if (kind === "removed") before.push(text);
      else after.push(text);
    }
    flush();
    if (noBefore || noAfter) emit({ kind: "no-newline", side: noBefore && noAfter ? "both" : noBefore ? "before" : "after" });
  }
  return { body: output.body, lines, moreLines: Math.max(0, count - limit), added: output.added, removed: output.removed };
};

const textHtml = (text: string) => esc(text).replaceAll("\r", "&#13;");
const noNewline = { before: "変更前", after: "変更後", both: "変更前と変更後" };
export const diffLineHtml = (line: DiffLine): string => {
  if (line.kind === "hunk") return `<span class="d-hunk">${textHtml(line.text)}</span>`;
  if (line.kind === "no-newline") return `<span class="d-hunk">${noNewline[line.side]}に末尾改行なし</span>`;
  const before = line.spans.some((s) => s.kind !== "added");
  const after = line.spans.some((s) => s.kind !== "removed");
  const sharedNewline = line.spans.some((s) => s.kind === "same" && s.text.endsWith("\n"));
  return line.spans.map(({ kind, text }) => {
    const escaped = textHtml(text.replace(/\n$/, ""));
    const newline = text.endsWith("\n") && !sharedNewline && (before && after || !escaped) ? "↵" : "";
    if (kind === "removed") return `<del class="d-word-del">${escaped}${newline}</del>`;
    if (kind === "added") return `<ins class="d-word-add">${escaped}${newline}</ins>`;
    return escaped;
  }).join("");
};

export const diffTextHtml = (lines: DiffLine[]) => lines.map(diffLineHtml).join("\n") + "\n";
