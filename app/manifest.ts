// The `chapters` array of manifest.toml: reading the chapter files and adding one
// (docs/adr/0004). Items are a string, an inline table with `file`, or a nested
// array (which Golem treats as one chapter).

type Tok = { t: "str"; v: string; at: number; end: number } | { t: "ch"; v: string; at: number } | { t: "word"; v: string; at: number };

/** Characters of TOML relevant to arrays, skipping comments and string contents. */
const lex = (src: string, from: number): Tok[] => {
  const out: Tok[] = [];
  let i = from;
  while (i < src.length) {
    const c = src[i];
    if (c === "#") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const triple = src.startsWith(c.repeat(3), i);
      const q = triple ? c.repeat(3) : c;
      let j = i + q.length;
      let v = "";
      while (j < src.length && !src.startsWith(q, j)) {
        if (c === '"' && src[j] === "\\" && j + 1 < src.length) {
          const n = src[j + 1];
          v += ({ n: "\n", t: "\t", '"': '"', "\\": "\\" } as Record<string, string>)[n] ?? n;
          j += 2;
          continue;
        }
        v += src[j++];
      }
      out.push({ t: "str", v, at: i, end: j + q.length });
      i = j + q.length;
      continue;
    }
    if ("[]{},=".includes(c)) {
      out.push({ t: "ch", v: c, at: i });
      i++;
      continue;
    }
    const w = /^[A-Za-z0-9_-]+/.exec(src.slice(i, i + 64));
    if (w) {
      out.push({ t: "word", v: w[0], at: i });
      i += w[0].length;
      continue;
    }
    i++;
  }
  return out;
};

/** Where the value of `chapters = [...]` starts and ends (the brackets' offsets). */
const chaptersSpan = (src: string): { open: number; close: number } | null => {
  const m = /^[ \t]*chapters[ \t]*=[ \t]*\[/m.exec(src);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  let depth = 0;
  for (const tk of lex(src, open)) {
    if (tk.t !== "ch") continue;
    if (tk.v === "[" || tk.v === "{") depth++;
    if (tk.v === "]" || tk.v === "}") depth--;
    if (depth === 0) return { open, close: tk.at };
  }
  return null;
};

/** The chapter files in order. A nested array gives each of its files; an inline table its `file`. */
export const manifestChapters = (src: string): string[] => {
  const span = chaptersSpan(src);
  if (!span) return [];
  const toks = lex(src.slice(0, span.close), span.open + 1);
  const out: string[] = [];
  let inTable = 0;
  toks.forEach((tk, i) => {
    if (tk.t === "ch") {
      if (tk.v === "{") inTable++;
      if (tk.v === "}") inTable--;
      return;
    }
    if (tk.t !== "str") return;
    if (!inTable) return void out.push(tk.v);
    // inside an inline table, only the value of `file =`
    const [k, eq] = [toks[i - 2], toks[i - 1]];
    if (k?.t === "word" && k.v === "file" && eq?.t === "ch" && eq.v === "=") out.push(tk.v);
  });
  return out;
};

/** The manifest with `rel` added at the end of `chapters`, keeping the array's layout. */
export const addChapter = (src: string, rel: string): string => {
  const item = `"${rel.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const span = chaptersSpan(src);
  if (!span) return `chapters = [${item}]\n${src}`;
  const inner = src.slice(span.open + 1, span.close);
  if (!inner.trim()) return src.slice(0, span.open + 1) + item + src.slice(span.close);
  if (inner.includes("\n")) {
    // one item per line: add a line with the same indentation, after a comma
    const lines = inner.split("\n");
    const last = [...lines].reverse().find((l) => l.trim()) ?? "";
    const indent = /^\s*/.exec(last)![0] || "  ";
    const body = inner.replace(/\s*$/, "");
    const sep = body.trimEnd().endsWith(",") ? "" : ",";
    const tail = inner.slice(body.length);
    return src.slice(0, span.open + 1) + body + sep + "\n" + indent + item + (tail.includes("\n") ? tail : "\n") + src.slice(span.close);
  }
  const body = inner.replace(/\s*,?\s*$/, "");
  return src.slice(0, span.open + 1) + body + ", " + item + src.slice(span.close);
};

export type Separator = "blank-line" | "line";

const sep = (v: string | undefined): Separator | null => (v === "line" || v === "blank-line" ? v : null);

/**
 * How paragraphs of a file are separated (Golem's paragraph-separator): the
 * file's own `@manifest`, then its item in `chapters`, then `[source]`, then blank-line.
 */
export const paragraphSeparator = (manifest: string, rel: string, fileText: string): Separator => {
  const own = /^[ \t]*@manifest\b[^\n]*\bparagraph-separator\s*=\s*"?([a-z-]+)"?/m.exec(fileText.split("\n").slice(0, 20).join("\n"))?.[1];
  if (sep(own)) return sep(own)!;
  const span = chaptersSpan(manifest);
  if (span) {
    const toks = lex(manifest.slice(0, span.close), span.open + 1);
    let table: Record<string, string> | null = null;
    for (let i = 0; i < toks.length; i++) {
      const tk = toks[i];
      if (tk.t === "ch" && tk.v === "{") table = {};
      else if (tk.t === "ch" && tk.v === "}" && table) {
        if (table.file === rel && sep(table["paragraph-separator"])) return sep(table["paragraph-separator"])!;
        table = null;
      } else if (table && tk.t === "word" && toks[i + 1]?.t === "ch" && toks[i + 1].v === "=" && toks[i + 2]?.t === "str") table[tk.v] = toks[i + 2].v;
    }
  }
  const lines = manifest.split("\n");
  const start = lines.findIndex((l) => l.trim() === "[source]");
  if (start >= 0)
    for (const l of lines.slice(start + 1)) {
      if (/^\s*\[/.test(l)) break;
      const v = sep(/^\s*paragraph-separator\s*=\s*"([^"]*)"/.exec(l)?.[1]);
      if (v) return v;
    }
  return "blank-line";
};

// ---- taking chapters out for the trash and putting them back (docs/adr/0033) ----

type Item = { start: number; end: number; files: string[]; children: Item[] | null };

/** The items of the array whose brackets are at `open` and `close`. */
const itemsOf = (src: string, open: number, close: number): Item[] => {
  const toks = lex(src.slice(0, close), open + 1);
  const out: Item[] = [];
  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i];
    if (tk.t === "str") {
      out.push({ start: tk.at, end: tk.end, files: [tk.v], children: null });
      continue;
    }
    if (tk.t !== "ch" || (tk.v !== "{" && tk.v !== "[")) continue;
    let depth = 0;
    let j = i;
    for (; j < toks.length; j++) {
      const t = toks[j];
      if (t.t !== "ch") continue;
      if (t.v === "[" || t.v === "{") depth++;
      if (t.v === "]" || t.v === "}") depth--;
      if (depth === 0) break;
    }
    const endAt = (toks[j] as { at: number }).at + 1;
    if (tk.v === "[") {
      const children = itemsOf(src, tk.at, endAt - 1);
      out.push({ start: tk.at, end: endAt, files: children.flatMap((c) => c.files), children });
    } else out.push({ start: tk.at, end: endAt, files: manifestChapters(`chapters = [${src.slice(tk.at, endAt)}]`), children: null });
    i = j;
  }
  return out;
};

const multiline = (src: string, open: number, close: number) => src.slice(open + 1, close).includes("\n");

/** The source with one item of a list taken out, with its comma and (one per line) its line. */
const cut = (src: string, items: Item[], k: number, lines: boolean): string => {
  const it = items[k];
  if (lines) {
    const from = src.lastIndexOf("\n", it.start - 1) + 1;
    const nl = src.indexOf("\n", it.end);
    return src.slice(0, from) + src.slice(nl < 0 ? src.length : nl + 1);
  }
  if (k + 1 < items.length) return src.slice(0, it.start) + src.slice(items[k + 1].start);
  if (k > 0) return src.slice(0, items[k - 1].end) + src.slice(it.end);
  return src.slice(0, it.start) + src.slice(it.end);
};

/** One item put into a list at `k` (the end when past it). */
const put = (src: string, items: Item[], k: number, text: string, open: number, lines: boolean): string => {
  if (lines && items.length) {
    if (k < items.length) {
      const from = src.lastIndexOf("\n", items[k].start - 1) + 1;
      const indent = /^[ \t]*/.exec(src.slice(from))![0];
      return src.slice(0, from) + `${indent}${text},\n` + src.slice(from);
    }
    const last = items[items.length - 1];
    const from = src.lastIndexOf("\n", last.start - 1) + 1;
    const indent = /^[ \t]*/.exec(src.slice(from))![0];
    const nl = src.indexOf("\n", last.end);
    const lineEnd = nl < 0 ? src.length : nl;
    const comma = src.slice(last.end, lineEnd).trim().startsWith(",");
    return comma
      ? src.slice(0, lineEnd + 1) + `${indent}${text},\n` + src.slice(lineEnd + 1)
      : src.slice(0, last.end) + `,\n${indent}${text}` + src.slice(last.end);
  }
  if (k < items.length) return src.slice(0, items[k].start) + `${text}, ` + src.slice(items[k].start);
  if (items.length) return src.slice(0, items[items.length - 1].end) + `, ${text}` + src.slice(items[items.length - 1].end);
  return src.slice(0, open + 1) + text + src.slice(open + 1);
};

export type RemovedChapter = { index: number[]; text: string };

/**
 * The manifest with the chapters `rels` taken out of `chapters` (in nested
 * arrays too; a nested array left empty goes whole), and what was taken with
 * its place, in the order to put it back.
 */
export const removeChapters = (src: string, rels: string[]): { src: string; removed: RemovedChapter[] } => {
  const removed: RemovedChapter[] = [];
  for (;;) {
    const span = chaptersSpan(src);
    if (!span) break;
    const items = itemsOf(src, span.open, span.close);
    // the last match first, so the earlier places stay as they were
    const k = items.map((it) => it.files.some((f) => rels.includes(f))).lastIndexOf(true);
    if (k < 0) break;
    const it = items[k];
    const kids = it.children;
    if (kids && kids.some((c) => !c.files.some((f) => rels.includes(f)))) {
      const j = kids.map((c) => c.files.some((f) => rels.includes(f))).lastIndexOf(true);
      removed.push({ index: [k, j], text: src.slice(kids[j].start, kids[j].end) });
      src = cut(src, kids, j, multiline(src, it.start, it.end - 1));
      continue;
    }
    removed.push({ index: [k], text: src.slice(it.start, it.end) });
    src = cut(src, items, k, multiline(src, span.open, span.close));
  }
  return { src, removed: removed.sort((a, b) => a.index[0] - b.index[0] || (a.index[1] ?? -1) - (b.index[1] ?? -1)) };
};

/** The manifest with removed chapters put back at their places (renamed when given). */
export const restoreChapters = (src: string, removed: RemovedChapter[], rename?: { from: string; to: string }): string => {
  for (const r of removed) {
    const text = rename ? r.text.split(`"${rename.from}"`).join(`"${rename.to}"`) : r.text;
    const span = chaptersSpan(src);
    if (!span) {
      src = `chapters = [${text}]\n${src}`;
      continue;
    }
    const items = itemsOf(src, span.open, span.close);
    if (r.index.length === 2 && items[r.index[0]]?.children) {
      const it = items[r.index[0]];
      src = put(src, it.children!, r.index[1], text, it.start, multiline(src, it.start, it.end - 1));
    } else src = put(src, items, r.index[0], text, span.open, multiline(src, span.open, span.close));
  }
  return src;
};
