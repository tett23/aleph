// Golem source handling for the prototype: highlighting, plain text,
// md -> gm, page break estimates and counts. All approximations.
import { StreamLanguage, type StringStream } from "@codemirror/language";

type GmState = { depth: number; comment: boolean; fence: boolean };

/** A tokenizer for .gm: headings, block commands, inline commands, expressions, comments. */
export const gmLanguage = StreamLanguage.define<GmState>({
  name: "gm",
  startState: () => ({ depth: 0, comment: false, fence: false }),
  copyState: (s) => ({ ...s }),
  token(stream: StringStream, state: GmState) {
    if (stream.sol() && stream.match(/^```/)) {
      state.fence = !state.fence;
      stream.skipToEnd();
      return "meta";
    }
    if (state.fence) {
      stream.skipToEnd();
      return "monospace";
    }
    if (state.comment) {
      if (stream.match(/^.*?%%/)) {
        state.comment = false;
      } else stream.skipToEnd();
      return "comment";
    }
    if (stream.match("%%")) {
      if (!stream.match(/^.*?%%/)) {
        state.comment = true;
        stream.skipToEnd();
      }
      return "comment";
    }
    if (stream.sol() && stream.match(/^#{1,6}(?= )/)) {
      return "heading processingInstruction";
    }
    if (stream.sol() && stream.match(/^#{1,6} .*/)) return "heading";
    if (stream.sol() && stream.match(/^\s*@[a-z][\w.-]*/)) {
      return "keyword";
    }
    if (stream.match(/^\[=/)) {
      state.depth++;
      return "string";
    }
    if (stream.match(/^\[[a-z][\w-]*(\.[\w-]+)?:?/)) {
      state.depth++;
      return "keyword";
    }
    if (state.depth > 0 && stream.eat("]")) {
      state.depth--;
      return "keyword";
    }
    if (state.depth > 0 && stream.eat("|")) return "keyword";
    if (stream.match(/^\\./)) return "escape";
    stream.next();
    while (!stream.eol() && !/[[\]%|\\@]/.test(stream.peek() ?? "")) stream.next();
    return null;
  },
  blankLine(state) {
    state.comment = false;
  },
});

/** .emet is Haskell-like. */
export const emetLanguage = StreamLanguage.define<{ c: number }>({
  name: "emet",
  startState: () => ({ c: 0 }),
  token(stream, state) {
    if (state.c > 0) {
      if (stream.match(/^.*?-\}/)) state.c = 0;
      else stream.skipToEnd();
      return "comment";
    }
    if (stream.match("{-")) {
      state.c = 1;
      return "comment";
    }
    if (stream.match(/^--.*/)) return "comment";
    if (stream.match(/^"(?:[^"\\]|\\.)*"/)) return "string";
    if (stream.match(/^\d+/)) return "number";
    if (stream.match(/^(pub|inline|block|filter|fn|import|as|where|case|of|let|in|if|then|else|data|type)\b/))
      return "keyword";
    if (stream.match(/^[A-Z][\w]*/)) return "typeName";
    if (stream.match(/^(::|->|=>|=|\\)/)) return "operator";
    if (stream.match(/^[a-z_][\w']*/)) return "variableName";
    stream.next();
    return null;
  },
});

/** Removes commands and expressions; keeps the first prose slot of inline commands. */
export const inlinePlain = (s: string): string => {
  let out = "";
  let i = 0;
  const take = (): string => {
    // at '[' : returns the plain text of the bracket and advances i
    i++;
    if (s[i] === "=") {
      let d = 1;
      while (i < s.length && d > 0) {
        i++;
        if (s[i] === "[") d++;
        else if (s[i] === "]") d--;
      }
      i++;
      return "";
    }
    // command head until ':' or ']'
    let d = 1;
    let head = true;
    let slot = 0;
    let text = "";
    while (i < s.length && d > 0) {
      const c = s[i];
      if (c === "\\" && i + 1 < s.length) {
        if (!head && slot === 0) text += s[i + 1];
        i += 2;
        continue;
      }
      if (c === "[") {
        const inner = take();
        if (!head && slot === 0) text += inner;
        continue;
      }
      if (c === "]") {
        d--;
        i++;
        continue;
      }
      if (head && c === ":") {
        head = false;
        i++;
        if (s[i] === " ") i++;
        continue;
      }
      if (!head && c === "|") {
        slot++;
        i++;
        continue;
      }
      if (!head && slot === 0) text += c;
      i++;
    }
    return text.replace(/\//g, "");
  };
  while (i < s.length) {
    if (s.startsWith("%%", i)) {
      const end = s.indexOf("%%", i + 2);
      i = end < 0 ? s.length : end + 2;
      continue;
    }
    if (s[i] === "\\" && i + 1 < s.length) {
      out += s[i + 1];
      i += 2;
      continue;
    }
    if (s[i] === "[") {
      out += take();
      continue;
    }
    out += s[i];
    i++;
  }
  return out;
};

export type Block = { kind: "h"; level: number; text: string; line: number } | { kind: "p"; text: string; line: number } | { kind: "break"; line: number };

/** Splits .gm source into headings and paragraphs, without commands and expressions. */
export const gmBlocks = (src: string, separator: "blank-line" | "line" = "blank-line"): Block[] => {
  const lines = src.split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  let paraLine = 0;
  let fence = false;
  let comment = false;
  const flush = () => {
    const text = para.join("").trim();
    if (text) blocks.push({ kind: "p", text, line: paraLine });
    para = [];
  };
  lines.forEach((raw, n) => {
    if (raw.startsWith("```")) {
      flush();
      fence = !fence;
      return;
    }
    if (fence) return;
    if (comment) {
      if (raw.includes("%%")) comment = false;
      return;
    }
    const line = raw.replace(/\\$/, "");
    if ((line.match(/%%/g) ?? []).length % 2 === 1) comment = true;
    if (/^\s*$/.test(line)) return flush();
    if (/^#{1,6} /.test(line)) {
      flush();
      const m = /^(#{1,6}) (.*)$/.exec(line)!;
      blocks.push({ kind: "h", level: m[1].length, text: inlinePlain(m[2]), line: n });
      return;
    }
    if (/^\s*@page-break\b|^\s*@column-break\b/.test(line)) {
      flush();
      blocks.push({ kind: "break", line: n });
      return;
    }
    if (/^\s*@/.test(line) || /^\s{2,}/.test(raw) && para.length === 0) {
      // block commands and their indented arguments
      if (/^\s*@/.test(line)) flush();
      return;
    }
    const text = inlinePlain(line.replace(/^\s*[-+]\s+/, "").replace(/^\|/, ""));
    if (separator === "line") {
      flush();
      paraLine = n;
      para.push(text);
      flush();
      return;
    }
    if (para.length === 0) paraLine = n;
    para.push(text);
  });
  flush();
  return blocks;
};

export type Grid = { chars: number; lines: number; vertical: boolean };

/** Reads the grid from style.toml text (very loosely). */
export const readGrid = (styleToml: string): Grid => {
  const num = (k: string, d: number) => {
    const m = new RegExp(`^\\s*${k}\\s*=\\s*(\\d+)`, "m").exec(styleToml);
    return m ? Number(m[1]) : d;
  };
  return {
    chars: num("characters", 40),
    lines: num("lines", 16),
    vertical: /writing-mode\s*=\s*"vertical"/.test(styleToml),
  };
};

/** Source line numbers before which a page break falls (approximate). */
export const estimatePageBreaks = (src: string, grid: Grid): { line: number; page: number }[] => {
  const result: { line: number; page: number }[] = [];
  const lines = src.split("\n");
  let used = 0;
  let page = 1;
  const next = (line: number) => {
    page++;
    used = 0;
    result.push({ line, page });
  };
  for (const b of gmBlocks(src)) {
    if (b.kind === "break") {
      next(b.line + 1);
      continue;
    }
    if (b.kind === "h") {
      const need = b.level === 1 ? 3 : 2;
      if (used + need > grid.lines) next(b.line);
      used += need;
      continue;
    }
    // walk the source lines of the paragraph to place breaks inside it
    let chars = 0;
    let n = b.line;
    const total = Math.max(1, Math.ceil([...b.text].length / grid.chars));
    let placed = 0;
    while (placed < total) {
      if (used >= grid.lines) next(n);
      const src = lines[n] ?? "";
      chars += [...inlinePlain(src)].length;
      const upto = Math.min(total, Math.max(placed + (src.trim() ? 0 : 1), Math.ceil(chars / grid.chars)));
      const room = grid.lines - used;
      const add = Math.min(room, Math.max(0, upto - placed));
      used += add;
      placed += add;
      if (upto - placed > 0) continue; // the page filled within this source line
      n++;
      if (n > lines.length + 1) break;
    }
  }
  return result;
};

export type Stats = { chars: number; words: number; sheets: number };

const segmenter = new Intl.Segmenter("ja", { granularity: "word" });

export const countWords = (text: string) => {
  let n = 0;
  for (const s of segmenter.segment(text)) if (s.isWordLike) n++;
  return n;
};

/** Characters without spaces, words, and 400-character manuscript sheets. */
export const stats = (paragraphs: string[], cols: number, rows: number): Stats => {
  const all = paragraphs.join("");
  const chars = [...all.replace(/\s/g, "")].length;
  const lines = paragraphs.reduce((a, p) => a + Math.max(1, Math.ceil([...p].length / cols)), 0);
  return { chars, words: countWords(paragraphs.join(" ")), sheets: Math.round((lines / rows) * 10) / 10 };
};

/** The paragraphs of a file for counting, by its kind. */
export const plainParagraphs = (kind: string, src: string): string[] => {
  if (kind === "gm") return gmBlocks(src).flatMap((b) => (b.kind === "break" ? [] : [b.text]));
  if (kind === "md")
    return src
      .split(/\n\s*\n/)
      .map((p) => p.replace(/^#+\s*|[*_`>]|!?\[([^\]]*)\]\([^)]*\)/gm, "$1").replace(/\n/g, ""))
      .filter((p) => p.trim());
  return src.split(/\n\s*\n/).filter((p) => p.trim());
};

const escGm = (s: string) => s.replace(/([[\]|\\])/g, "\\$1").replace(/%%/g, "\\%\\%");

const mdInline = (s: string): string => {
  // code first, its content is literal
  const parts = s.split(/(`[^`]+`)/);
  return parts
    .map((p) =>
      p.startsWith("`") && p.endsWith("`") && p.length > 1
        ? `[code: ${escGm(p.slice(1, -1))}]`
        : escGm(p)
            .replace(/!\\\[([^\]]*)\\\]\(([^)]*)\)/g, "$1")
            .replace(/\\\[([^\]]*)\\\]\(([^)]*)\)/g, "$1")
            .replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_, a, b) => `[strong: ${a ?? b}]`)
            .replace(/\*(.+?)\*|_(.+?)_/g, (_, a, b) => `[italic: ${a ?? b}]`),
    )
    .join("");
};

/** Converts Markdown to .gm: headings, paragraphs, lists, code blocks, tables, emphasis. */
export const mdToGm = (md: string): string => {
  const out: string[] = [];
  let fence = false;
  for (const line of md.replace(/\r\n/g, "\n").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      out.push(line.trim().replace(/^~~~/, "```"));
      continue;
    }
    if (fence) {
      out.push(line);
      continue;
    }
    const img = /^\s*!\[([^\]]*)\]\(([^)\s]+)[^)]*\)\s*$/.exec(line);
    if (img) {
      out.push(`%% figure: ${img[2]} ${img[1]} %%`);
      continue;
    }
    let m: RegExpExecArray | null;
    if ((m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) out.push(`${m[1]} ${mdInline(m[2])}`);
    else if ((m = /^(\s*)[-*+]\s+(.*)$/.exec(line))) out.push(`${" ".repeat(Math.floor(m[1].length / 2) * 2)}- ${mdInline(m[2])}`);
    else if ((m = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line))) out.push(`${" ".repeat(Math.floor(m[1].length / 2) * 2)}+ ${mdInline(m[3])}`);
    else if (/^\s*>\s?/.test(line)) out.push(mdInline(line.replace(/^\s*>\s?/, "")));
    else if (/^\s*(\*\s*){3,}$|^\s*(-\s*){3,}$/.test(line)) out.push("");
    else if (/^\s*\|/.test(line)) out.push(line.trim());
    else out.push(mdInline(line.replace(/^\s+/, "")).replace(/ {2}$/, "\\"));
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
};
