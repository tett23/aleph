// Golem source (.gm) for the editor, without CodeMirror: a fallback tokenizer for
// the time before the LSP's semantic tokens arrive, the text without commands, and
// page break estimates (docs/adr/0006).
import type { Grid } from "./store.ts";

export type TokenType = "command" | "expression" | "comment" | "heading" | "headingMark" | "escape" | "fence" | "code";
export type Token = { from: number; to: number; type: TokenType };

/** The bracket stack: inside [= ...], in a command's head and arguments, or in a prose slot. */
type Ctx = "expr" | "head" | "prose";
export type LineState = { stack: Ctx[]; comment: boolean; fence: boolean };

export const startState = (): LineState => ({ stack: [], comment: false, fence: false });

/** The tokens of one line, and the state after it. A blank line ends open brackets and comments. */
export const tokenizeLine = (line: string, state: LineState): { tokens: Token[]; state: LineState } => {
  const st: LineState = { stack: [...state.stack], comment: state.comment, fence: state.fence };
  const out: Token[] = [];
  const push = (from: number, to: number, type: TokenType) => {
    if (to <= from) return;
    const last = out[out.length - 1];
    if (last && last.type === type && last.to === from) last.to = to;
    else out.push({ from, to, type });
  };
  if (!line.trim()) return { tokens: [], state: { stack: [], comment: false, fence: st.fence } };
  if (/^```/.test(line)) {
    st.fence = !st.fence;
    push(0, line.length, "fence");
    return { tokens: out, state: st };
  }
  if (st.fence) {
    push(0, line.length, "code");
    return { tokens: out, state: st };
  }
  let i = 0;
  let heading = false;
  let blockLine = false;
  if (!st.stack.length && !st.comment) {
    const h = /^#{1,6}(?= )/.exec(line);
    if (h) {
      push(0, h[0].length, "headingMark");
      i = h[0].length;
      heading = true;
    } else {
      const b = /^\s*@[a-z][\w.-]*/.exec(line);
      if (b) {
        push(0, b[0].length, "command");
        i = b[0].length;
        blockLine = true;
      }
    }
  }
  const prose = (from: number, to: number) => {
    if (heading) push(from, to, "heading");
    else if (blockLine && !st.stack.length) push(from, to, "command");
  };
  while (i < line.length) {
    if (st.comment) {
      const end = line.indexOf("%%", i);
      const to = end < 0 ? line.length : end + 2;
      push(i, to, "comment");
      if (end >= 0) st.comment = false;
      i = to;
      continue;
    }
    if (line.startsWith("%%", i)) {
      const end = line.indexOf("%%", i + 2);
      const to = end < 0 ? line.length : end + 2;
      push(i, to, "comment");
      if (end < 0) st.comment = true;
      i = to;
      continue;
    }
    const top = st.stack[st.stack.length - 1];
    const c = line[i];
    if (top === "expr") {
      if (c === "[") st.stack.push("expr");
      if (c === "]") st.stack.pop();
      push(i, i + 1, "expression");
      i++;
      continue;
    }
    if (c === "\\" && i + 1 < line.length && top !== "head") {
      push(i, i + 2, "escape");
      i += 2;
      continue;
    }
    if (c === "[" && line[i + 1] === "=") {
      st.stack.push("expr");
      push(i, i + 2, "expression");
      i += 2;
      continue;
    }
    const cmd = c === "[" ? /^\[[a-z][\w-]*(\.[\w-]+)?/.exec(line.slice(i)) : null;
    if (cmd) {
      st.stack.push("head");
      push(i, i + cmd[0].length, "command");
      i += cmd[0].length;
      continue;
    }
    if (top === "head") {
      if (c === ":") st.stack[st.stack.length - 1] = "prose";
      if (c === "]") st.stack.pop();
      if (c === '"') {
        const m = /^"(?:[^"\\]|\\.)*"?/.exec(line.slice(i))!;
        push(i, i + m[0].length, "command");
        i += m[0].length;
        continue;
      }
      push(i, i + 1, "command");
      i++;
      continue;
    }
    if (st.stack.length && (c === "]" || c === "|")) {
      if (c === "]") st.stack.pop();
      push(i, i + 1, "command");
      i++;
      continue;
    }
    prose(i, i + 1);
    i++;
  }
  return { tokens: out, state: st };
};

/** The text of an inline run without commands and expressions; a command keeps its first prose slot. */
export const inlinePlain = (s: string): string => {
  let out = "";
  let i = 0;
  const take = (): string => {
    i++; // past '['
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
    let head = true;
    let slot = 0;
    let text = "";
    while (i < s.length) {
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
        i++;
        break;
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
    out += s[i++];
  }
  return out;
};

export type Block = { kind: "h"; level: number; text: string; line: number } | { kind: "p"; text: string; line: number } | { kind: "break"; line: number };

/** Headings, paragraphs and forced breaks of a .gm source, without commands (0-based lines). */
export const gmBlocks = (src: string, separator: "blank-line" | "line" = "blank-line"): Block[] => {
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
  src.split("\n").forEach((raw, n) => {
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
    if (!line.trim()) return flush();
    const h = /^(#{1,6}) (.*)$/.exec(line);
    if (h) {
      flush();
      blocks.push({ kind: "h", level: h[1].length, text: inlinePlain(h[2]), line: n });
      return;
    }
    if (/^\s*@(page-break|column-break)\b/.test(line)) {
      flush();
      blocks.push({ kind: "break", line: n });
      return;
    }
    if (/^\s*@/.test(line)) return flush();
    if (/^\s{2,}/.test(raw) && para.length === 0) return; // a block command's indented body
    const text = inlinePlain(line.replace(/^\s*[-+]\s+/, ""));
    if (separator === "line") {
      flush();
      paraLine = n;
      para.push(text);
      return flush();
    }
    if (para.length === 0) paraLine = n;
    para.push(text);
  });
  flush();
  return blocks;
};

export type PageBreak = { line: number; page: number };

/**
 * Where page breaks fall, estimated: each paragraph takes ceil(chars / grid.chars) lines,
 * headings take 3 (level 1) or 2 lines, @page-break starts a page; paragraphs
 * follow the file's paragraph separator. Kinsoku, ruby and
 * line gaps are not counted, so this is only an estimate (docs/adr/0006).
 */
export const estimatePageBreaks = (src: string, grid: Grid, separator: "blank-line" | "line" = "blank-line"): PageBreak[] => {
  const result: PageBreak[] = [];
  const lines = src.split("\n");
  let used = 0;
  let page = 1;
  const next = (line: number) => {
    page++;
    used = 0;
    result.push({ line, page });
  };
  for (const b of gmBlocks(src, separator)) {
    if (b.kind === "break") {
      if (b.line + 1 < lines.length) next(b.line + 1);
      continue;
    }
    if (b.kind === "h") {
      const need = b.level === 1 ? 3 : 2;
      if (used + need > grid.lines && used > 0) next(b.line);
      used += need;
      continue;
    }
    // walk the source lines of the paragraph, to place a break inside it
    let chars = 0;
    let placed = 0;
    let n = b.line;
    const total = Math.max(1, Math.ceil([...b.text].length / grid.chars));
    while (placed < total && n < lines.length) {
      if (used >= grid.lines) next(n);
      chars += [...inlinePlain(lines[n])].length;
      const upto = Math.min(total, Math.max(placed, Math.ceil(chars / grid.chars)));
      const add = Math.min(grid.lines - used, upto - placed);
      used += add;
      placed += add;
      if (placed < upto) continue; // the page filled within this source line
      n++;
    }
  }
  return result;
};
