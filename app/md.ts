// A Markdown reader shared by the preview (docs/adr/0010), the count (docs/adr/0012)
// and the conversion to .gm (docs/adr/0016): CommonMark's blocks and inlines without
// HTML, and GFM's strikethrough, task lists, autolinks and tables (docs/adr/0035).
// docs/adr/0061 made it read what CommonMark reads (Setext headings, indented code,
// reference links, entities, blocks in quotes and list items) in time linear in the
// input: emphasis and links by CommonMark's delimiter stack, no copies of the rest
// of a line.
import { ENTITIES } from "./entities.ts";
import { esc } from "./esc.ts";
import { within } from "./path.ts";

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong"; c: Inline[] }
  | { t: "em"; c: Inline[] }
  | { t: "del"; c: Inline[] }
  | { t: "link"; href: string; c: Inline[] }
  | { t: "image"; src: string; alt: string }
  | { t: "wikilink"; target: string; heading: string | null; text: string | null }
  /** A soft line break; `cjk` when a character on either side is CJK (docs/adr/0035): no space then. */
  | { t: "softbreak"; cjk: boolean }
  | { t: "hardbreak" };

/** A list item: its blocks; `checked` only for a task list item (docs/adr/0035). */
export type ListItem = { c: Block[]; checked?: boolean };

/** How a paragraph's newlines are drawn (docs/adr/0035). */
export type Breaks = "newline" | "blank-line";

export type Align = "left" | "center" | "right" | null;

export type Block =
  | { t: "heading"; level: number; c: Inline[] }
  | { t: "para"; c: Inline[] }
  | { t: "quote"; c: Block[] }
  | { t: "list"; ordered: boolean; start: number; tight: boolean; items: ListItem[] }
  /** `lang` is the info string's first word; `info` the whole. */
  | { t: "code"; lang: string; info: string; text: string }
  /** Every row has as many cells as the head (GFM). */
  | { t: "table"; align: Align[]; head: Inline[][]; rows: Inline[][][] }
  | { t: "hr" }
  | { t: "image"; src: string; alt: string }
  /** A whole line `![[target#heading]]` (docs/adr/0029). */
  | { t: "embed"; target: string; heading: string | null }
  /** YAML front matter between --- lines at the top. */
  | { t: "front"; text: string };

// ---- characters ----

/** Characters around which a soft break draws no space (CSS Text's segment break transformation). */
export const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}　-〿＀-￯]/u;
const ASCII_PUNCT = /[!-/:-@[-`{-~]/;
const PUNCT = /[\p{P}\p{S}]/u;
const SPACE = /[\s\p{Zs}]/u;

const entity = (name: string): string | null => {
  if (name[0] !== "#") return Object.hasOwn(ENTITIES, name) ? ENTITIES[name] : null;
  const n = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
  return !Number.isFinite(n) || n === 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff) ? "�" : String.fromCodePoint(n);
};
const ENTITY = /&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/y;

/** Backslash escapes and entities, as in link destinations and titles. */
const unescape = (s: string) =>
  s.replace(/\\([!-/:-@[-`{-~])|&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/g, (m, p: string | undefined, e: string | undefined) => p ?? entity(e!) ?? m);

/** A link label as compared: trimmed, inner whitespace one space, case folded. */
const normLabel = (s: string) => s.trim().replace(/[ \t\r\n]+/g, " ").toLowerCase().toUpperCase();

export type Ref = { href: string };
type Refs = Map<string, Ref>;

// ---- inline ----

type Node = { x: Inline; prev: Node | null; next: Node | null };
type Delim = { node: Node; ch: string; len: number; orig: number; open: boolean; close: boolean; prev: Delim | null; next: Delim | null };
type Bracket = { node: Node; image: boolean; active: boolean; pos: number; delims: Delim | null; prev: Bracket | null };

/** A URL at `i` in `s` (https://, http://, www.), without trailing punctuation or an unmatched ")". */
const URL_RUN = /(?:https?:\/\/|www\.)[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/iy;
const bareUrl = (s: string, i: number): string | null => {
  URL_RUN.lastIndex = i;
  const m = URL_RUN.exec(s);
  if (!m) return null;
  let u = m[0];
  for (;;) {
    if (/[?!.,:*_~'";]$/.test(u)) u = u.slice(0, -1);
    else if (u.endsWith(")") && (u.match(/\)/g) ?? []).length > (u.match(/\(/g) ?? []).length) u = u.slice(0, -1);
    else break;
  }
  return /^(?:https?:\/\/|www\.)[^/]*[A-Za-z0-9]/i.test(u) ? u : null;
};

const AUTOLINK = /<((?:https?|mailto):[^\s<>\x00-\x1f]*)>/iy;
const EMAIL = /<([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/y;
const PLAIN = /[^\\`&<\n[\]!*_~hHwW]+/y;
const TITLE = /(?:"((?:[^"\\]|\\[\s\S])*)"|'((?:[^'\\]|\\[\s\S])*)'|\(((?:[^()\\]|\\[\s\S])*)\))/y;
const SP = /[ \t]*\n?[ \t]*/y;

const plainOf = (xs: Inline[]): string =>
  xs
    .map((x) =>
      x.t === "text" || x.t === "code"
        ? x.v
        : x.t === "image"
          ? x.alt
          : x.t === "wikilink"
            ? wikiText(x)
            : x.t === "softbreak" || x.t === "hardbreak"
              ? "\n"
              : plainOf(x.c),
    )
    .join("");

/** Index tables for `s`: the next "]]" and the next "[" or "]" at or after each index (wikilinks in one pass). */
const nextTables = (s: string) => {
  const dbl = new Int32Array(s.length + 2).fill(-1);
  const br = new Int32Array(s.length + 2).fill(-1);
  for (let i = s.length - 1; i >= 0; i--) {
    dbl[i] = s[i] === "]" && s[i + 1] === "]" ? i : dbl[i + 1];
    br[i] = s[i] === "[" || s[i] === "]" ? i : br[i + 1];
  }
  return { dbl, br };
};

/** Backtick runs by length, for finding a code span's closing run without rescanning. */
const tickRuns = (s: string) => {
  const by = new Map<number, number[]>();
  for (let i = 0; i < s.length; ) {
    if (s[i] !== "`") {
      i++;
      continue;
    }
    let j = i;
    while (s[j] === "`") j++;
    const l = by.get(j - i) ?? [];
    l.push(i);
    by.set(j - i, l);
    i = j;
  }
  return by;
};

export const parseInline = (s: string, refs: Refs = new Map()): Inline[] => {
  let head: Node | null = null;
  let tail: Node | null = null;
  const append = (x: Inline): Node => {
    const n: Node = { x, prev: tail, next: null };
    if (tail) tail.next = n;
    else head = n;
    tail = n;
    return n;
  };
  const text = (v: string) => {
    if (tail && tail.x.t === "text" && !delimOf.has(tail) && !bracketOf.has(tail)) tail.x.v += v;
    else append({ t: "text", v });
  };
  const unlink = (n: Node) => {
    if (n.prev) n.prev.next = n.next;
    else head = n.next;
    if (n.next) n.next.prev = n.prev;
    else tail = n.prev;
  };
  const delimOf = new Set<Node>();
  const bracketOf = new Set<Node>();
  let delims: Delim | null = null;
  let brackets: Bracket | null = null;
  const removeDelim = (d: Delim) => {
    if (d.prev) d.prev.next = d.next;
    if (d.next) d.next.prev = d.prev;
    else delims = d.prev;
    delimOf.delete(d.node);
  };
  const charAt = (i: number) => (i < 0 || i >= s.length ? "\n" : s[i]);
  // CommonMark's flanking rules; a CJK character next to the run counts like punctuation does, so
  // **「強調」**の and 強**調**する read as Japanese writers mean them
  const flank = (before: string, after: string) => {
    const ws = (c: string) => SPACE.test(c);
    const pu = (c: string) => PUNCT.test(c);
    const cj = (c: string) => CJK.test(c);
    const left = !ws(after) && (!pu(after) || ws(before) || pu(before) || cj(before));
    const right = !ws(before) && (!pu(before) || ws(after) || pu(after) || cj(after));
    return { left, right, pb: pu(before) || cj(before), pa: pu(after) || cj(after) };
  };

  const { dbl, br } = nextTables(s);
  const ticks = tickRuns(s);
  const tickNext = new Map<number, number>();

  /** Links and emphasis: CommonMark's "process emphasis" above `bottom`. */
  const processEmphasis = (bottom: Delim | null) => {
    const openersBottom = new Map<string, Delim | null>();
    if (delims === bottom) return;
    let cur: Delim | null = delims;
    // to the first above bottom
    while (cur && cur.prev !== bottom) cur = cur.prev;
    while (cur) {
      if (!cur.close) {
        cur = cur.next;
        continue;
      }
      const key = `${cur.ch}${cur.open ? 1 : 0}${cur.orig % 3}`;
      const floor = openersBottom.has(key) ? openersBottom.get(key)! : bottom;
      let o: Delim | null = cur.prev;
      let found: Delim | null = null;
      while (o && o !== bottom && o !== floor) {
        if (o.ch === cur.ch && o.open) {
          const odd = (o.close || cur.open) && (o.orig + cur.orig) % 3 === 0 && !(o.orig % 3 === 0 && cur.orig % 3 === 0);
          const tilde = cur.ch !== "~" || (o.len === 2 && cur.len === 2);
          if (!odd && tilde) {
            found = o;
            break;
          }
        }
        o = o.prev;
      }
      if (!found) {
        openersBottom.set(key, cur.prev);
        const next: Delim | null = cur.next;
        if (!cur.open) removeDelim(cur);
        cur = next;
        continue;
      }
      const use = cur.ch === "~" ? 2 : found.len >= 2 && cur.len >= 2 ? 2 : 1;
      found.len -= use;
      cur.len -= use;
      (found.node.x as { v: string }).v = (found.node.x as { v: string }).v.slice(use);
      (cur.node.x as { v: string }).v = (cur.node.x as { v: string }).v.slice(use);
      // the nodes between the two runs become the children
      const kids: Inline[] = [];
      for (let n = found.node.next; n && n !== cur.node; ) {
        const nx: Node | null = n.next;
        kids.push(n.x);
        unlink(n);
        n = nx;
      }
      const x: Inline = cur.ch === "~" ? { t: "del", c: merge(kids) } : use === 2 ? { t: "strong", c: merge(kids) } : { t: "em", c: merge(kids) };
      const made: Node = { x, prev: found.node, next: cur.node };
      found.node.next = made;
      cur.node.prev = made;
      // delimiters between them are gone
      for (let d = found.next; d && d !== cur; ) {
        const nd: Delim | null = d.next;
        removeDelim(d);
        d = nd;
      }
      if (found.len === 0) {
        unlink(found.node);
        removeDelim(found);
      }
      if (cur.len === 0) {
        const next: Delim | null = cur.next;
        unlink(cur.node);
        removeDelim(cur);
        cur = next;
      }
    }
    while (delims && delims !== bottom) removeDelim(delims);
  };

  /** An inline link's destination and title after "](" at `i`; the index after ")" or -1. */
  const inlineLink = (i: number): { href: string; end: number } | null => {
    let j = i;
    SP.lastIndex = j;
    SP.exec(s);
    j = SP.lastIndex;
    let href = "";
    if (s[j] === "<") {
      let k = j + 1;
      while (k < s.length && s[k] !== ">" && s[k] !== "<" && s[k] !== "\n") k += s[k] === "\\" ? 2 : 1;
      if (s[k] !== ">") return null;
      href = s.slice(j + 1, k);
      j = k + 1;
    } else {
      let k = j;
      let depth = 0;
      while (k < s.length) {
        const c = s[k];
        if (c === "\\" && ASCII_PUNCT.test(s[k + 1] ?? "")) {
          k += 2;
          continue;
        }
        if (c === " " || c === "\t" || c === "\n" || c < " ") break;
        if (c === "(") {
          if (++depth > 32) return null;
        } else if (c === ")") {
          if (depth === 0) break;
          depth--;
        }
        k++;
      }
      if (depth !== 0) return null;
      href = s.slice(j, k);
      j = k;
    }
    const before = j;
    SP.lastIndex = j;
    SP.exec(s);
    j = SP.lastIndex;
    if (j > before && s[j] !== ")") {
      TITLE.lastIndex = j;
      if (!TITLE.exec(s)) return null;
      j = TITLE.lastIndex;
      SP.lastIndex = j;
      SP.exec(s);
      j = SP.lastIndex;
    }
    if (s[j] !== ")") return null;
    return { href: unescape(href), end: j + 1 };
  };

  /** A link label `[...]` at `i` (up to 999 characters, no unescaped brackets); its text and the index after it. */
  const label = (i: number): { v: string; end: number } | null => {
    if (s[i] !== "[") return null;
    let k = i + 1;
    while (k < s.length && k - i <= 1000) {
      if (s[k] === "\\") k += 2;
      else if (s[k] === "[") return null;
      else if (s[k] === "]") return { v: s.slice(i + 1, k), end: k + 1 };
      else k++;
    }
    return null;
  };

  const closeBracket = (i: number): number => {
    const o = brackets;
    if (!o) {
      text("]");
      return i + 1;
    }
    if (!o.active) {
      brackets = o.prev;
      bracketOf.delete(o.node);
      text("]");
      return i + 1;
    }
    let href: string | null = null;
    let end = i + 1;
    if (s[i + 1] === "(") {
      const r = inlineLink(i + 2);
      if (r) {
        href = r.href;
        end = r.end;
      }
    }
    if (href === null) {
      const l = label(i + 1);
      const key = l && l.v.trim() ? l.v : !l || l.v === "" ? s.slice(o.pos, i) : null;
      const ref = key !== null && key.length <= 999 ? refs.get(normLabel(key)) : undefined;
      if (ref) {
        href = ref.href;
        end = l ? l.end : i + 1;
      }
    }
    if (href === null) {
      brackets = o.prev;
      bracketOf.delete(o.node);
      text("]");
      return i + 1;
    }
    processEmphasis(o.delims);
    const kids: Inline[] = [];
    for (let n = o.node.next; n; ) {
      const nx: Node | null = n.next;
      kids.push(n.x);
      unlink(n);
      n = nx;
    }
    const c = merge(kids);
    o.node.x = o.image ? { t: "image", src: href, alt: plainOf(c).replace(/\n/g, " ") } : { t: "link", href, c };
    bracketOf.delete(o.node);
    brackets = o.prev;
    // no links in links: the openers before a link are spent
    if (!o.image) for (let b = brackets; b; b = b.prev) if (!b.image) b.active = false;
    return end;
  };

  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") {
      if (s[i + 1] === "\n") {
        append({ t: "hardbreak" });
        i += 2;
        while (s[i] === " " || s[i] === "\t") i++;
      } else if (i + 1 < s.length && ASCII_PUNCT.test(s[i + 1])) {
        text(s[i + 1]);
        i += 2;
      } else {
        text("\\");
        i++;
      }
      continue;
    }
    if (c === "`") {
      let j = i;
      while (s[j] === "`") j++;
      const n = j - i;
      const list = ticks.get(n) ?? [];
      let at = tickNext.get(n) ?? 0;
      while (at < list.length && list[at] <= i) at++;
      tickNext.set(n, at);
      if (at < list.length) {
        const end = list[at];
        let v = s.slice(j, end).replace(/\n/g, " ");
        if (/^ .* $/s.test(v) && v.trim()) v = v.slice(1, -1);
        append({ t: "code", v });
        i = end + n;
        tickNext.set(n, at + 1);
      } else {
        text(s.slice(i, j));
        i = j;
      }
      continue;
    }
    if (c === "&") {
      ENTITY.lastIndex = i;
      const m = ENTITY.exec(s);
      const v = m && entity(m[1]);
      if (m && v !== null) {
        text(v);
        i = ENTITY.lastIndex;
      } else {
        text("&");
        i++;
      }
      continue;
    }
    if (c === "<") {
      AUTOLINK.lastIndex = i;
      const m = AUTOLINK.exec(s);
      if (m) {
        append({ t: "link", href: m[1], c: [{ t: "text", v: m[1] }] });
        i = AUTOLINK.lastIndex;
        continue;
      }
      EMAIL.lastIndex = i;
      const e = EMAIL.exec(s);
      if (e) {
        append({ t: "link", href: `mailto:${e[1]}`, c: [{ t: "text", v: e[1] }] });
        i = EMAIL.lastIndex;
        continue;
      }
      text("<");
      i++;
      continue;
    }
    if (c === "\n") {
      // two spaces before the newline make a hard break
      const t = tail as Node | null;
      let hard = false;
      if (t && t.x.t === "text" && !delimOf.has(t) && !bracketOf.has(t)) {
        hard = / {2,}$/.test(t.x.v);
        t.x.v = t.x.v.replace(/[ \t]+$/, "");
        if (!t.x.v) unlink(t);
      }
      append(hard ? { t: "hardbreak" } : { t: "softbreak", cjk: false });
      i++;
      while (s[i] === " " || s[i] === "\t") i++;
      continue;
    }
    // a wikilink (docs/adr/0027)
    if (c === "[" && s[i + 1] === "[") {
      const close = dbl[i + 2];
      if (close >= 0 && br[i + 2] === close) {
        const inner = s.slice(i + 2, close);
        const bar = inner.indexOf("|");
        const dest = bar < 0 ? inner : inner.slice(0, bar);
        const hash = dest.indexOf("#");
        const heading = hash < 0 ? null : dest.slice(hash + 1).trim() || null;
        const target = (hash < 0 ? dest : dest.slice(0, hash)).trim();
        if (inner.trim() && !inner.includes("\n") && (target || heading)) {
          append({ t: "wikilink", target, heading, text: bar < 0 ? null : inner.slice(bar + 1).trim() || null });
          i = close + 2;
          continue;
        }
      }
    }
    if (c === "[" || (c === "!" && s[i + 1] === "[")) {
      const image = c === "!";
      const node = append({ t: "text", v: image ? "![" : "[" });
      bracketOf.add(node);
      brackets = { node, image, active: true, pos: i + (image ? 2 : 1), delims, prev: brackets };
      i += image ? 2 : 1;
      continue;
    }
    if (c === "]") {
      i = closeBracket(i);
      continue;
    }
    if (c === "*" || c === "_" || c === "~") {
      let j = i;
      while (s[j] === c) j++;
      const run = s.slice(i, j);
      const f = flank(charAt(i - 1), charAt(j));
      const open = c === "_" ? f.left && (!f.right || f.pb) : f.left;
      const close = c === "_" ? f.right && (!f.left || f.pa) : f.right;
      const node = append({ t: "text", v: run });
      if ((open || close) && (c !== "~" || run.length === 2)) {
        delimOf.add(node);
        const d: Delim = { node, ch: c, len: run.length, orig: run.length, open, close, prev: delims, next: null };
        if (delims) delims.next = d;
        delims = d;
      }
      i = j;
      continue;
    }
    // GFM: URLs in the text
    if ((c === "h" || c === "H" || c === "w" || c === "W") && (i === 0 || !/[A-Za-z0-9]/.test(s[i - 1]))) {
      const url = bareUrl(s, i);
      if (url) {
        append({ t: "link", href: /^www\./i.test(url) ? `http://${url}` : url, c: [{ t: "text", v: url }] });
        i += url.length;
        continue;
      }
    }
    PLAIN.lastIndex = i;
    const m = PLAIN.exec(s);
    if (m && m[0]) {
      text(m[0]);
      i = PLAIN.lastIndex;
    } else {
      text(c);
      i++;
    }
  }
  processEmphasis(null);
  const out: Inline[] = [];
  for (let n = head as Node | null; n; n = n.next) out.push(n.x);
  return breaksMarked(merge(out));
};

/** Adjacent text nodes as one; empty ones dropped. */
const merge = (xs: Inline[]): Inline[] => {
  const out: Inline[] = [];
  for (const x of xs) {
    if (x.t === "text" && !x.v) continue;
    const last = out[out.length - 1];
    if (x.t === "text" && last?.t === "text") out[out.length - 1] = { t: "text", v: last.v + x.v };
    else out.push(x);
  }
  return out;
};

/** Each soft break learns whether a CJK character stands next to it (the visible text around it). */
const breaksMarked = (xs: Inline[]): Inline[] => {
  const leaves: (Inline & { t: "softbreak" } | string)[] = [];
  const walk = (ys: Inline[]) => {
    for (const y of ys) {
      if (y.t === "softbreak") leaves.push(y);
      else if (y.t === "hardbreak") leaves.push("\n");
      else if (y.t === "text" || y.t === "code") leaves.push(y.v);
      else if (y.t === "image") leaves.push(y.alt);
      else if (y.t === "wikilink") leaves.push(wikiText(y));
      else walk(y.c);
    }
  };
  walk(xs);
  leaves.forEach((l, k) => {
    if (typeof l === "string") return;
    let a = "";
    for (let p = k - 1; p >= 0 && !a; p--) if (typeof leaves[p] === "string") a = [...(leaves[p] as string)].pop() ?? "";
    let b = "";
    for (let p = k + 1; p < leaves.length && !b; p++) if (typeof leaves[p] === "string") b = [...(leaves[p] as string)][0] ?? "";
    l.cjk = CJK.test(a) || CJK.test(b);
  });
  return xs;
};

// ---- blocks ----

/** The columns of leading whitespace (tabs to the next multiple of 4) and where the text starts. */
const lead = (l: string) => {
  let col = 0;
  let i = 0;
  while (i < l.length && (l[i] === " " || l[i] === "\t")) {
    col = l[i] === "\t" ? col + 4 - (col % 4) : col + 1;
    i++;
  }
  return { col, i };
};

/** `l` without its first `n` columns of leading whitespace (a tab partly used leaves spaces). */
const dedent = (l: string, n: number): string => {
  let col = 0;
  let i = 0;
  while (i < l.length && col < n && (l[i] === " " || l[i] === "\t")) {
    const w = l[i] === "\t" ? 4 - (col % 4) : 1;
    if (col + w > n) return " ".repeat(col + w - n) + l.slice(i + 1);
    col += w;
    i++;
  }
  return l.slice(i);
};

const blank = (l: string | undefined) => l === undefined || !/[^ \t]/.test(l);

const HR = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const ATX_EMPTY = /^ {0,3}(#{1,6})[ \t]*$/;
const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const ITEM = /^( {0,3})([-+*]|(\d{1,9})([.)]))(?=[ \t]|$)/;
const QUOTE = /^ {0,3}>/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const IMAGE_LINE = /^\s*!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$/;
const EMBED_LINE = /^\s*!\[\[([^[\]|]+)\]\]\s*$/;
const TABLE_SEP = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const REF_DEF =
  /^ {0,3}\[((?:[^\\[\]]|\\.){0,999})\]:[ \t]*\n?[ \t]*(<(?:[^\n<>\\]|\\.)*>|[^\s\x00-\x1f]+)(?:[ \t]*\n?[ \t]*("(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*'|\((?:[^()\\]|\\[\s\S])*\)))?[ \t]*(?:\n|$)/;

/** A line that is a whole embed, read into its target and heading (docs/adr/0029). */
export const embedOf = (line: string): { target: string; heading: string | null } | null => {
  const m = EMBED_LINE.exec(line);
  if (!m) return null;
  const hash = m[1].indexOf("#");
  const target = (hash < 0 ? m[1] : m[1].slice(0, hash)).trim();
  const heading = hash < 0 ? null : m[1].slice(hash + 1).trim() || null;
  return target || heading ? { target, heading } : null;
};

/** A table row's cells: split at unescaped |, the outer ones dropped, \| kept for the inline reader to undo. */
const cellsOf = (row: string) => {
  let r = row.trim();
  if (r.startsWith("|")) r = r.slice(1);
  if (r.endsWith("|") && !r.endsWith("\\|")) r = r.slice(0, -1);
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < r.length; i++) {
    if (r[i] === "\\" && r[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (r[i] === "|") {
      out.push(cur.trim());
      cur = "";
    } else cur += r[i];
  }
  out.push(cur.trim());
  return out;
};
const alignOf = (c: string): Align => (/^:-+:$/.test(c) ? "center" : /^:-+$/.test(c) ? "left" : /^-+:$/.test(c) ? "right" : null);

const tableStarts = (l: string, next: string | undefined) =>
  l.includes("|") && next !== undefined && next.includes("-") && TABLE_SEP.test(next) && (next.includes("|") || l.includes("|")) && cellsOf(l).length === cellsOf(next).length;

type ItemStart = { indent: number; bullet: string; ordered: boolean; start: number; width: number; rest: string };
const itemStart = (l: string): ItemStart | null => {
  if (HR.test(l)) return null;
  const m = ITEM.exec(l);
  if (!m) return null;
  const after = l.slice(m[0].length);
  const markerEnd = m[1].length + m[2].length;
  const sp = lead(after);
  const restText = after.slice(sp.i);
  // an empty item, or one starting with indented code: the content is one column after the marker
  const width = !restText || sp.col >= 5 ? markerEnd + 1 : markerEnd + sp.col;
  const rest = !restText ? "" : sp.col >= 5 ? dedent(after, 1) : restText;
  return { indent: m[1].length, bullet: m[3] ? m[4] : m[2], ordered: !!m[3], start: m[3] ? Number(m[3]) : 1, width, rest };
};

type Raw =
  | { t: "heading"; level: number; raw: string }
  | { t: "para"; raw: string }
  | { t: "quote"; c: Raw[] }
  | { t: "list"; ordered: boolean; start: number; tight: boolean; items: { c: Raw[]; checked?: boolean }[] }
  | { t: "code"; lang: string; info: string; text: string }
  | { t: "table"; align: Align[]; head: string[]; rows: string[][] }
  | { t: "hr" }
  | { t: "image"; src: string; alt: string }
  | { t: "embed"; target: string; heading: string | null }
  | { t: "front"; text: string };

/** Whether `l` starts a block that ends a paragraph (a list item only when not empty and, numbered, from 1). */
const interrupts = (l: string, next: string | undefined) => {
  if (HR.test(l) || ATX.test(l) || ATX_EMPTY.test(l) || QUOTE.test(l) || IMAGE_LINE.test(l) || embedOf(l) || tableStarts(l, next)) return true;
  const f = FENCE.exec(l);
  if (f && !(f[2][0] === "`" && f[3].includes("`"))) return true;
  const it = itemStart(l);
  return !!it && !!it.rest.trim() && (!it.ordered || it.start === 1);
};

/** The blocks of `lines`, link definitions put into `refs`. */
const blocks = (lines: string[], refs: Refs, top: boolean): Raw[] => {
  const out: Raw[] = [];
  let i = 0;
  // front matter: --- at the very top, to the next --- or ...
  if (top && /^---[ \t]*$/.test(lines[0] ?? "")) {
    const end = lines.findIndex((l, k) => k > 0 && /^(?:---|\.\.\.)[ \t]*$/.test(l));
    if (end > 0) {
      out.push({ t: "front", text: lines.slice(1, end).join("\n") });
      i = end + 1;
    }
  }
  while (i < lines.length) {
    const l = lines[i];
    if (blank(l)) {
      i++;
      continue;
    }
    const ld = lead(l);
    // indented code: four columns in, not inside a paragraph
    if (ld.col >= 4) {
      const body: string[] = [];
      while (i < lines.length && (blank(lines[i]) || lead(lines[i]).col >= 4)) body.push(dedent(lines[i++], 4));
      while (body.length && blank(body[body.length - 1])) body.pop();
      out.push({ t: "code", lang: "", info: "", text: body.join("\n") });
      continue;
    }
    const fence = FENCE.exec(l);
    if (fence && !(fence[2][0] === "`" && fence[3].includes("`"))) {
      const ch = fence[2][0];
      const len = fence[2].length;
      const indent = fence[1].length;
      const info = unescape(fence[3].trim());
      const body: string[] = [];
      i++;
      const close = new RegExp(`^ {0,3}${ch === "`" ? "`" : "~"}{${len},}[ \\t]*$`);
      while (i < lines.length && !close.test(lines[i])) body.push(dedent(lines[i++], indent));
      i++;
      out.push({ t: "code", lang: info.split(/\s+/)[0] ?? "", info, text: body.join("\n") });
      continue;
    }
    if (HR.test(l)) {
      out.push({ t: "hr" });
      i++;
      continue;
    }
    const h = ATX.exec(l) ?? ATX_EMPTY.exec(l);
    if (h) {
      out.push({ t: "heading", level: h[1].length, raw: (h[2] ?? "").replace(/(?:^|[ \t]+)#+$/, "").trim() });
      i++;
      continue;
    }
    if (tableStarts(l, lines[i + 1])) {
      const head = cellsOf(l);
      const align = cellsOf(lines[i + 1]).map(alignOf);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && !blank(lines[i]) && !interrupts(lines[i], lines[i + 1])) {
        const cs = cellsOf(lines[i++]);
        rows.push(head.map((_, k) => cs[k] ?? ""));
      }
      out.push({ t: "table", align, head, rows });
      continue;
    }
    if (QUOTE.test(l)) {
      const inner: string[] = [];
      let para = false;
      while (i < lines.length) {
        const q = lines[i];
        if (QUOTE.test(q)) {
          const body = q.replace(/^ {0,3}>/, "");
          const rest = body.startsWith(" ") ? body.slice(1) : body.startsWith("\t") ? dedent(body, 1) : body;
          inner.push(rest);
          para = !blank(rest) && lead(rest).col < 4 && !interrupts(rest, undefined);
          i++;
        } else if (para && !blank(q) && !interrupts(q, lines[i + 1])) {
          // a lazy continuation of the quote's paragraph
          inner.push(q);
          i++;
        } else break;
      }
      out.push({ t: "quote", c: blocks(inner, refs, false) });
      continue;
    }
    const it = itemStart(l);
    if (it) {
      const items: { c: Raw[]; checked?: boolean }[] = [];
      let loose = false;
      let gapBefore = false;
      while (i < lines.length) {
        const s = itemStart(lines[i]);
        if (!s || s.ordered !== it.ordered || s.bullet !== it.bullet) break;
        if (gapBefore) loose = true;
        const body: string[] = [s.rest];
        i++;
        let lazy = !!s.rest.trim();
        // an item starting with a blank line holds at most one blank line before its content
        while (i < lines.length) {
          const x = lines[i];
          if (blank(x)) {
            if (body.length === 1 && !s.rest.trim()) break;
            body.push("");
            lazy = false;
            i++;
            continue;
          }
          if (lead(x).col >= s.width) {
            body.push(dedent(x, s.width));
            lazy = true;
            i++;
            continue;
          }
          if (lazy && !interrupts(x, lines[i + 1]) && !itemStart(x) && !SETEXT.test(x)) {
            body.push(x);
            i++;
            continue;
          }
          break;
        }
        // blank lines at the item's end belong between items
        let trailing = 0;
        while (body.length > 1 && blank(body[body.length - 1])) {
          body.pop();
          trailing++;
        }
        gapBefore = trailing > 0;
        const c = blocks(body, refs, false);
        // a blank line between the item's own blocks makes the list loose
        if (c.length > 1 && body.some((b, k) => k > 0 && blank(b))) loose = true;
        const first = c[0];
        const task = first?.t === "para" ? /^\[([ xX])\][ \t]+(?=\S)/.exec(first.raw) : null;
        if (task && first?.t === "para") {
          first.raw = first.raw.slice(task[0].length);
          items.push({ c, checked: task[1] !== " " });
        } else items.push({ c });
      }
      out.push({ t: "list", ordered: it.ordered, start: it.start, tight: !loose, items });
      continue;
    }
    // an image alone on its line is a block of its own (docs/adr/0016)
    const em = embedOf(l);
    if (em) {
      out.push({ t: "embed", ...em });
      i++;
      continue;
    }
    const img = IMAGE_LINE.exec(l);
    if (img) {
      // escapes and entities as in an inline image
      out.push({ t: "image", alt: plainOf(parseInline(img[1], refs)).replace(/\n/g, " "), src: unescape(img[2]) });
      i++;
      continue;
    }
    // a paragraph, maybe a Setext heading
    const para: string[] = [l.replace(/^[ \t]+/, "")];
    i++;
    let setext = 0;
    while (i < lines.length && !blank(lines[i])) {
      const x = lines[i];
      const st = SETEXT.exec(x);
      if (st) {
        setext = st[1][0] === "=" ? 1 : 2;
        i++;
        break;
      }
      if (interrupts(x, lines[i + 1])) break;
      para.push(x.replace(/^[ \t]+/, ""));
      i++;
    }
    let raw = para.join("\n");
    // link reference definitions at the paragraph's start
    for (;;) {
      const d = REF_DEF.exec(raw);
      if (!d || !d[1].trim()) break;
      const key = normLabel(d[1]);
      const dest = d[2].startsWith("<") ? d[2].slice(1, -1) : d[2];
      if (!refs.has(key)) refs.set(key, { href: unescape(dest) });
      raw = raw.slice(d[0].length);
    }
    raw = raw.replace(/[ \t]+$/, "");
    if (setext && raw.trim()) out.push({ t: "heading", level: setext, raw });
    else if (raw.trim()) out.push({ t: "para", raw });
    else if (setext) out.push({ t: "para", raw: lines[i - 1].trim() });
  }
  return out;
};

const cooked = (b: Raw, refs: Refs): Block => {
  const inl = (s: string) => parseInline(s, refs);
  switch (b.t) {
    case "heading":
      return { t: "heading", level: b.level, c: inl(b.raw) };
    case "para":
      return { t: "para", c: inl(b.raw) };
    case "quote":
      return { t: "quote", c: b.c.map((x) => cooked(x, refs)) };
    case "list":
      return { ...b, items: b.items.map((it) => ({ ...it, c: it.c.map((x) => cooked(x, refs)) })) };
    case "table":
      return { t: "table", align: b.align, head: b.head.map(inl), rows: b.rows.map((r) => r.map(inl)) };
    default:
      return b;
  }
};

export const parseMarkdown = (src: string): Block[] => {
  const lines = src
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const refs: Refs = new Map();
  const raw = blocks(lines, refs, true);
  return raw.map((b) => cooked(b, refs));
};

// ---- HTML, for the preview ----

const safeUrl = (u: string) => (/^\s*(javascript|vbscript|data):/i.test(u) ? "#" : u);

/** What a wikilink shows: its label, or the target (with " > heading"). */
export function wikiText(x: { target: string; heading: string | null; text: string | null }) {
  return x.text ?? (x.heading ? (x.target ? `${x.target} > ${x.heading}` : x.heading) : x.target);
}

export const inlineHtml = (xs: Inline[], breaks: Breaks = "blank-line"): string =>
  xs
    .map((x) => {
      switch (x.t) {
        case "text":
          return esc(x.v);
        case "code":
          return `<code>${esc(x.v)}</code>`;
        case "strong":
          return `<strong>${inlineHtml(x.c, breaks)}</strong>`;
        case "em":
          return `<em>${inlineHtml(x.c, breaks)}</em>`;
        case "del":
          return `<del>${inlineHtml(x.c, breaks)}</del>`;
        case "link":
          return `<a href="${esc(safeUrl(x.href))}">${inlineHtml(x.c, breaks)}</a>`;
        case "image":
          return `<img src="${esc(safeUrl(x.src))}" alt="${esc(x.alt)}">`;
        case "wikilink":
          return `<a class="wikilink" data-wikilink="${esc(x.target)}"${x.heading ? ` data-heading="${esc(x.heading)}"` : ""} href="#">${esc(wikiText(x))}</a>`;
        case "hardbreak":
          return "<br>";
        case "softbreak":
          return breaks === "newline" ? "<br>" : x.cjk ? "" : "\n";
      }
    })
    .join("");

/** An embed as a link to its target, where nothing expands it (docs/adr/0029 expands it in the preview). */
const embedLink = (target: string, heading: string | null) =>
  `<p><a class="wikilink" data-wikilink="${esc(target)}"${heading ? ` data-heading="${esc(heading)}"` : ""} href="#">${esc(wikiText({ target, heading, text: null }))}</a></p>`;

const alignAttr = (a: Align | undefined) => (a ? ` style="text-align:${a}"` : "");

/** Where a sheet is and the workspace its images must stay in (docs/adr/0047). */
export type ImageBase = { dir: string; root: string };

export type HtmlOptions = { embed?: (target: string, heading: string | null) => string; breaks?: Breaks; base?: ImageBase };

const unesc = (s: string) => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[e]!);

/** An image the preview reads from the workspace, or a note in its place; remote images are never loaded. */
const imageHtml = (src: string, alt: string, base: ImageBase | undefined) => {
  const s = src.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith("//")) return `<span class="img-note">${esc(alt)}（外部の画像は読み込みません：${esc(s)}）</span>`;
  const p = base ? within(base.root, base.dir, s) : null;
  return p ? `<img data-src="${esc(p)}" alt="${esc(alt)}">` : `<span class="img-note">${esc(alt)}（ワークスペースの外の画像は読み込みません）</span>`;
};

const blockHtml = (b: Block, o: { embed: (target: string, heading: string | null) => string; breaks: Breaks }, tight = false): string => {
  switch (b.t) {
    case "heading":
      return `<h${b.level}>${inlineHtml(b.c, o.breaks)}</h${b.level}>`;
    case "para":
      return tight ? inlineHtml(b.c, o.breaks) : `<p>${inlineHtml(b.c, o.breaks)}</p>`;
    case "quote":
      return `<blockquote>${b.c.map((x) => blockHtml(x, o)).join("\n")}</blockquote>`;
    case "list": {
      const tag = b.ordered ? "ol" : "ul";
      const start = b.ordered && b.start !== 1 ? ` start="${b.start}"` : "";
      const items = b.items.map((it) => {
        const box = it.checked === undefined ? "" : `<input type="checkbox"${it.checked ? " checked" : ""} disabled> `;
        return `<li>${box}${it.c.map((x) => blockHtml(x, o, b.tight)).join(b.tight ? "" : "\n")}</li>`;
      });
      return `<${tag}${start}>${items.join("")}</${tag}>`;
    }
    case "code":
      return `<pre><code${b.lang ? ` class="language-${esc(b.lang)}"` : ""}>${esc(b.text)}</code></pre>`;
    case "table":
      return `<table><thead><tr>${b.head.map((c, k) => `<th${alignAttr(b.align[k])}>${inlineHtml(c, o.breaks)}</th>`).join("")}</tr></thead><tbody>${b.rows
        .map((r) => `<tr>${r.map((c, k) => `<td${alignAttr(b.align[k])}>${inlineHtml(c, o.breaks)}</td>`).join("")}</tr>`)
        .join("")}</tbody></table>`;
    case "hr":
      return "<hr>";
    case "image":
      return `<p><img src="${esc(safeUrl(b.src))}" alt="${esc(b.alt)}"></p>`;
    case "embed":
      return o.embed(b.target, b.heading);
    case "front":
      return `<pre class="front-matter">${esc(b.text)}</pre>`;
  }
};

export const markdownHtml = (src: string, { embed = embedLink, breaks = "blank-line", base }: HtmlOptions = {}): string =>
  parseMarkdown(src)
    .map((b) => blockHtml(b, { embed, breaks }))
    .join("\n")
    // the images this function wrote (inline and alone on a line), and only those
    .replace(/<img src="([^"]*)" alt="([^"]*)">/g, (_, s: string, a: string) => imageHtml(unesc(s), unesc(a), base));
