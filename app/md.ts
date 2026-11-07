// A small Markdown reader shared by the preview (docs/adr/0010) and the
// conversion to .gm (docs/adr/0016): CommonMark's common parts, no HTML.
import { esc } from "./esc.ts";

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong"; c: Inline[] }
  | { t: "em"; c: Inline[] }
  | { t: "link"; href: string; c: Inline[] }
  | { t: "image"; src: string; alt: string };

/** A line of a paragraph or quote, and whether it ends in a hard break (two spaces or a backslash). */
export type Line = { c: Inline[]; hard: boolean };

export type Block =
  | { t: "heading"; level: number; c: Inline[] }
  | { t: "para"; lines: Line[] }
  | { t: "quote"; lines: Line[] }
  | { t: "list"; items: { depth: number; ordered: boolean; c: Inline[] }[] }
  | { t: "code"; lang: string; text: string }
  | { t: "table"; rows: string[] }
  | { t: "hr" }
  | { t: "image"; src: string; alt: string };

// ---- inline ----

const PUNCT = /[!-/:-@[-`{-~]/;

/** The index of the delimiter `d` closing a run that starts at `from`, skipping code spans and escapes. */
const closing = (s: string, from: number, d: string): number => {
  for (let i = from; i < s.length; i++) {
    if (s[i] === "\\") {
      i++;
      continue;
    }
    if (s[i] === "`") {
      const run = /^`+/.exec(s.slice(i))![0];
      const end = s.indexOf(run, i + run.length);
      if (end > 0) i = end + run.length - 1;
      continue;
    }
    if (s.startsWith(d, i) && i > from && s[i - 1] !== " " && (d.length === 2 || s[i + 1] !== d[0])) return i;
    if (d.length === 1 && s.startsWith(d + d, i)) {
      // a strong run inside an emphasis: skip it whole
      const end = closing(s, i + 2, d + d);
      if (end > 0) i = end + 1;
    }
  }
  return -1;
};

/** The index of the `]` matching the `[` at `open`. */
const bracket = (s: string, open: number): number => {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === "[") depth++;
    else if (s[i] === "]" && --depth === 0) return i;
  }
  return -1;
};

export const parseInline = (s: string): Inline[] => {
  const out: Inline[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ t: "text", v: text });
    text = "";
  };
  const wordBefore = (i: number) => i > 0 && /[\p{L}\p{N}]/u.test(s[i - 1]);
  for (let i = 0; i < s.length; ) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length && PUNCT.test(s[i + 1])) {
      text += s[i + 1];
      i += 2;
      continue;
    }
    if (c === "`") {
      const run = /^`+/.exec(s.slice(i))![0];
      const end = s.indexOf(run, i + run.length);
      if (end > 0) {
        flush();
        const v = s.slice(i + run.length, end);
        out.push({ t: "code", v: /^ .* $/.test(v) && v.trim() ? v.slice(1, -1) : v });
        i = end + run.length;
        continue;
      }
      text += run;
      i += run.length;
      continue;
    }
    if (c === "!" && s[i + 1] === "[") {
      const close = bracket(s, i + 1);
      const m = close > 0 ? /^\(([^)\s]*)(?:\s+"[^"]*")?\)/.exec(s.slice(close + 1)) : null;
      if (m) {
        flush();
        out.push({ t: "image", src: m[1], alt: s.slice(i + 2, close) });
        i = close + 1 + m[0].length;
        continue;
      }
    }
    if (c === "[") {
      const close = bracket(s, i);
      const m = close > 0 ? /^\(([^)\s]*)(?:\s+"[^"]*")?\)/.exec(s.slice(close + 1)) : null;
      if (m) {
        flush();
        out.push({ t: "link", href: m[1], c: parseInline(s.slice(i + 1, close)) });
        i = close + 1 + m[0].length;
        continue;
      }
    }
    if ((c === "*" || c === "_") && s[i + 1] === c && s[i + 2] && s[i + 2] !== " " && !(c === "_" && wordBefore(i))) {
      const end = closing(s, i + 2, c + c);
      if (end > 0) {
        flush();
        out.push({ t: "strong", c: parseInline(s.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if ((c === "*" || c === "_") && s[i + 1] && s[i + 1] !== " " && s[i + 1] !== c && !(c === "_" && wordBefore(i))) {
      const end = closing(s, i + 1, c);
      if (end > 0) {
        flush();
        out.push({ t: "em", c: parseInline(s.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }
    text += c;
    i++;
  }
  flush();
  return out;
};

// ---- blocks ----

const HR = /^ {0,3}([-*_])( *\1){2,} *$/;
const HEADING = /^ {0,3}(#{1,6})(?: +(.*?))?(?: +#+)? *$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const IMAGE_LINE = /^\s*!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

const lineOf = (raw: string): Line => {
  const hard = / {2,}$/.test(raw) || /\\$/.test(raw);
  const body = raw.replace(/ {2,}$/, "").replace(/\\$/, "").trim();
  return { c: parseInline(body), hard };
};

export const parseMarkdown = (src: string): Block[] => {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = [];
  let i = 0;
  const blank = (l: string | undefined) => l === undefined || !l.trim();
  // a line that starts another block ends a paragraph
  const starts = (l: string) => HR.test(l) || HEADING.test(l) || FENCE.test(l) || ITEM.test(l) || QUOTE.test(l);
  while (i < lines.length) {
    const l = lines[i];
    if (blank(l)) {
      i++;
      continue;
    }
    const fence = FENCE.exec(l);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      out.push({ t: "code", lang: fence[2], text: body.join("\n") });
      continue;
    }
    if (HR.test(l)) {
      out.push({ t: "hr" });
      i++;
      continue;
    }
    const h = HEADING.exec(l);
    if (h) {
      out.push({ t: "heading", level: h[1].length, c: parseInline(h[2] ?? "") });
      i++;
      continue;
    }
    if (l.includes("|") && TABLE_SEP.test(lines[i + 1] ?? "") && lines[i + 1].includes("-")) {
      const rows: string[] = [];
      while (i < lines.length && !blank(lines[i]) && lines[i].includes("|")) rows.push(lines[i++]);
      out.push({ t: "table", rows });
      continue;
    }
    if (ITEM.test(l)) {
      const items: { depth: number; ordered: boolean; c: Inline[] }[] = [];
      const indents: number[] = [];
      while (i < lines.length && ITEM.test(lines[i])) {
        const m = ITEM.exec(lines[i])!;
        const indent = m[1].replace(/\t/g, "    ").length;
        while (indents.length && indent < indents[indents.length - 1]) indents.pop();
        if (!indents.length || indent > indents[indents.length - 1]) indents.push(indent);
        items.push({ depth: indents.length - 1, ordered: /\d/.test(m[2]), c: parseInline(m[3].trim()) });
        i++;
      }
      out.push({ t: "list", items });
      continue;
    }
    if (QUOTE.test(l)) {
      const q: Line[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        const body = QUOTE.exec(lines[i++])![1];
        if (body.trim()) q.push(lineOf(body));
      }
      out.push({ t: "quote", lines: q });
      continue;
    }
    const img = IMAGE_LINE.exec(l);
    if (img && blank(lines[i + 1])) {
      out.push({ t: "image", alt: img[1], src: img[2] });
      i++;
      continue;
    }
    const para: Line[] = [];
    while (i < lines.length && !blank(lines[i]) && (para.length === 0 || !starts(lines[i]))) para.push(lineOf(lines[i++]));
    out.push({ t: "para", lines: para });
  }
  return out;
};

// ---- HTML, for the preview ----

const safeUrl = (u: string) => (/^\s*(javascript|vbscript|data):/i.test(u) ? "#" : u);

export const inlineHtml = (xs: Inline[]): string =>
  xs
    .map((x) => {
      switch (x.t) {
        case "text":
          return esc(x.v);
        case "code":
          return `<code>${esc(x.v)}</code>`;
        case "strong":
          return `<strong>${inlineHtml(x.c)}</strong>`;
        case "em":
          return `<em>${inlineHtml(x.c)}</em>`;
        case "link":
          return `<a href="${esc(safeUrl(x.href))}">${inlineHtml(x.c)}</a>`;
        case "image":
          return `<img src="${esc(safeUrl(x.src))}" alt="${esc(x.alt)}">`;
      }
    })
    .join("");

const linesHtml = (ls: Line[]) => ls.map((l, n) => inlineHtml(l.c) + (n < ls.length - 1 ? (l.hard ? "<br>" : "\n") : "")).join("");

const cells = (row: string) =>
  row
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, "|"));

const listHtml = (items: { depth: number; ordered: boolean; c: Inline[] }[]): string => {
  let html = "";
  const stack: boolean[] = [];
  for (const it of items) {
    while (stack.length > it.depth + 1) html += `</li></${stack.pop() ? "ol" : "ul"}>`;
    if (stack.length === it.depth + 1) html += "</li>";
    while (stack.length < it.depth + 1) {
      stack.push(it.ordered);
      html += it.ordered ? "<ol>" : "<ul>";
    }
    html += `<li>${inlineHtml(it.c)}`;
  }
  while (stack.length) html += `</li></${stack.pop() ? "ol" : "ul"}>`;
  return html;
};

export const markdownHtml = (src: string): string =>
  parseMarkdown(src)
    .map((b) => {
      switch (b.t) {
        case "heading":
          return `<h${b.level}>${inlineHtml(b.c)}</h${b.level}>`;
        case "para":
          return `<p>${linesHtml(b.lines)}</p>`;
        case "quote":
          return `<blockquote><p>${linesHtml(b.lines)}</p></blockquote>`;
        case "list":
          return listHtml(b.items);
        case "code":
          return `<pre><code${b.lang ? ` class="language-${esc(b.lang)}"` : ""}>${esc(b.text)}</code></pre>`;
        case "table": {
          const [head, , ...body] = b.rows;
          return `<table><thead><tr>${cells(head).map((c) => `<th>${inlineHtml(parseInline(c))}</th>`).join("")}</tr></thead><tbody>${body
            .map((r) => `<tr>${cells(r).map((c) => `<td>${inlineHtml(parseInline(c))}</td>`).join("")}</tr>`)
            .join("")}</tbody></table>`;
        }
        case "hr":
          return "<hr>";
        case "image":
          return `<p><img src="${esc(safeUrl(b.src))}" alt="${esc(b.alt)}"></p>`;
      }
    })
    .join("\n");
