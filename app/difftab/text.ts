import { esc } from "../esc.ts";

export type DiffSpan = { kind: "same" | "removed" | "added"; text: string };
type EndOfFile = "before" | "after" | "both";
export type DiffLine =
  | { kind: "hunk" | "header"; text: string }
  | { kind: "text"; spans: DiffSpan[] }
  | { kind: "no-newline"; side: EndOfFile };

export type DiffOutput = { ordinary: string; porcelain: string };
type Hunk = { heading: string; lines: string[] };
type Patch = { header: string[]; hunks: Hunk[] };

const patches = (output: string): Patch[] => {
  const result: Patch[] = [];
  let file: Patch = { header: [], hunks: [] };
  let hunk: Hunk | undefined;
  const lines = output.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      if (file.header.length || file.hunks.length) result.push(file);
      file = { header: [line], hunks: [] };
      hunk = undefined;
    } else if (line.startsWith("@@ ")) {
      hunk = { heading: line, lines: [] };
      file.hunks.push(hunk);
    } else if (hunk) hunk.lines.push(line);
    else file.header.push(line);
  }
  if (file.header.length || file.hunks.length) result.push(file);
  return result;
};

const diffOptions = (args: string[], word: boolean) => [
  args[0], "--no-color", "--no-ext-diff",
  ...(word ? ["--word-diff=porcelain", "--word-diff-regex=."] : ["--word-diff=none"]),
  ...args.slice(1),
];

const signature = (files: Patch[]) =>
  JSON.stringify(files.map((f) => [f.header, f.hunks.map((h) => h.heading)]));

export const fetchDiff = async (
  run: (args: string[]) => Promise<{ code: number; stdout: string }>,
  args: string[],
): Promise<DiffOutput | undefined> => {
  // The working tree can change while Git reads it. Pair patches only when their
  // file headers (including blob IDs) and hunk headings match.
  for (let attempt = 0; attempt < 2; attempt++) {
    const ordinary = await run(diffOptions(args, false));
    if (ordinary.code !== 0 && ordinary.code !== 1) return;
    const files = patches(ordinary.stdout);
    if (!files.some((file) => file.hunks.length)) return { ordinary: ordinary.stdout, porcelain: "" };
    const word = await run(diffOptions(args, true));
    if (word.code !== 0 && word.code !== 1) return;
    if (signature(files) === signature(patches(word.stdout))) return { ordinary: ordinary.stdout, porcelain: word.stdout };
  }
};

const wordLines = (hunk: Hunk): DiffLine[] => {
  const lines: DiffLine[] = [{ kind: "hunk", text: hunk.heading }];
  let spans: DiffSpan[] = [];
  for (const line of hunk.lines) {
    if (line === "~") {
      lines.push({ kind: "text", spans });
      spans = [];
    } else if (line.startsWith(" ") || line.startsWith("-") || line.startsWith("+")) {
      const kind = line[0] === " " ? "same" : line[0] === "-" ? "removed" : "added";
      const text = line.slice(1);
      if (text) spans.push({ kind, text });
    }
  }
  if (spans.length) lines.push({ kind: "text", spans });
  return lines;
};

export const readDiffText = (output: DiffOutput, limit: number, includeHeader = false) => {
  const plain = patches(output.ordinary);
  const word = patches(output.porcelain);
  let added = 0;
  let removed = 0;
  const lines: DiffLine[] = [];
  for (const [i, file] of plain.entries()) {
    if (includeHeader || lines.length) {
      lines.push(...file.header.map((text): DiffLine => ({ kind: "header", text })));
    }
    for (const [j, hunk] of file.hunks.entries()) {
      const runs = word[i]?.hunks[j];
      if (runs) for (const line of wordLines(runs)) lines.push(line);
      let before = false;
      let after = false;
      for (const [k, line] of hunk.lines.entries()) {
        if (line.startsWith("+")) added++;
        else if (line.startsWith("-")) removed++;
        else if (line.startsWith("\\ ")) {
          const previous = hunk.lines[k - 1]?.[0];
          before ||= previous === "-" || previous === " ";
          after ||= previous === "+" || previous === " ";
        }
      }
      if (before || after) lines.push({ kind: "no-newline", side: before && after ? "both" : before ? "before" : "after" });
    }
  }
  const hasHunks = plain.some((file) => file.hunks.length);
  const binary = plain.some((file) => file.header.some((line) => line.startsWith("Binary files ")));
  const body = hasHunks ? "lines" as const : binary ? "binary" as const : "empty" as const;
  return { body, lines: lines.slice(0, limit), moreLines: Math.max(0, lines.length - limit), added, removed };
};

const textHtml = (text: string) => esc(text).replaceAll("\r", "&#13;");
const noNewline = { before: "変更前", after: "変更後", both: "変更前と変更後" };
export const diffLineHtml = (line: DiffLine): string => {
  if (line.kind === "hunk") return `<span class="d-hunk">${textHtml(line.text)}</span>`;
  if (line.kind === "no-newline") return `<span class="d-hunk">${noNewline[line.side]}に末尾改行なし</span>`;
  if (line.kind !== "text") return textHtml(line.text);
  return line.spans.map(({ kind, text }) => {
    const escaped = textHtml(text);
    if (kind === "removed") return `<del class="d-word-del">${escaped}</del>`;
    if (kind === "added") return `<ins class="d-word-add">${escaped}</ins>`;
    return escaped;
  }).join("");
};

export const diffTextHtml = (lines: DiffLine[]) => lines.map(diffLineHtml).join("\n") + "\n";
