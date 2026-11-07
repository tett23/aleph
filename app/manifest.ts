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
