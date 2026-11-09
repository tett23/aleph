// Markdown to Golem (docs/adr/0016), over the same reader as the Markdown preview.
// docs/adr/0061 made every result one that golem check reads: escapes, tables written
// anew from their cells, figures by where the image is, links as [link], soft breaks
// joined by the characters around them, and the blocks in quotes and list items.
import type { Separator } from "./manifest.ts";
import { parseMarkdown, wikiText, type Block, type Inline } from "./md.ts";

/** Where the .md is (from the project's root; null outside a project) and how embeds are found. */
export type GmCtx = {
  dir: string | null;
  /** An embed's target, found as a wikilink is (docs/adr/0027): its path from the project's root, or null. */
  resolveEmbed: (target: string) => string | null;
};

const NO_CTX: GmCtx = { dir: null, resolveEmbed: () => null };

// ---- characters ----

/**
 * Characters Golem cannot read anywhere in a source (rc4): C0 controls but tab and newline, U+FFFE, U+FFFF; and
 * U+FEFF, which Golem takes for a BOM at the start of the file, where removing a mark before it can bring it.
 */
const CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1F\uFEFF\uFFFE\uFFFF]/g;

/** Running text: \ and [ escaped, each % of a run of two or more, and ## before a digit (Golem's ##N## numbers). */
const escText = (s: string) =>
  s
    .replace(/\\/g, "\\\\")
    .replace(/\[/g, "\\[")
    .replace(/%{2,}/g, (m) => "\\%".repeat(m.length))
    .replace(/##(?=[0-9])/g, "\\##");
/** Inside a prose slot ] and | also end or split the command. */
const escSlot = (s: string) => escText(s).replace(/\]/g, "\\]").replace(/\|/g, "\\|");
/** In a table cell | splits the cells. */
const escCell = (s: string) => escText(s).replace(/\|/g, "\\|");
/** A string literal (a figure's path and alt, a link's URL). */
const quote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** A line that would start a block in Golem keeps its first character as text. */
const guard = (line: string) => (/^(?:[#\-+=@|]|```)/.test(line) ? `\\${line}` : line);

// ---- URLs ----

/**
 * An http(s) URL as Golem takes it (RFC 3986's absolute URI with an ASCII host): the ASCII characters RFC 3986
 * does not allow, and % not before two hex digits, as %XX; null when it cannot be one.
 */
export const golemUrl = (u: string): string | null => {
  const m = /^(https?):\/\/([^/?#]*)([\s\S]*)$/i.exec(u.trim());
  // the authority: [userinfo@] (an IPv6 literal in brackets or a registered name) [:port]
  if (!m || !/^(?:[A-Za-z0-9\-._~!$&'()*+,;=:]*@)?(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9\-._~!$&'()*+,;=]+)(?::[0-9]*)?$/.test(m[2])) return null;
  const pct = (c: string) => "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0");
  const fix = (s: string) => s.replace(/%(?![0-9A-Fa-f]{2})/g, "%25").replace(/[\x00-\x20"<>[\]{}|\\^`\x7f]/g, pct);
  const hash = m[3].indexOf("#");
  const rest = hash < 0 ? fix(m[3]) : fix(m[3].slice(0, hash)) + "#" + fix(m[3].slice(hash + 1)).replace(/#/g, "%23");
  return `${m[1].toLowerCase()}://${m[2]}${rest}`;
};

// ---- inline ----

/** How a run of inlines is written: in a prose slot, in a table cell, and whether soft breaks may keep their line. */
type Mode = { slot: boolean; cell: boolean; oneLine: boolean };

const plain = (xs: Inline[]): string =>
  xs.map((x) => (x.t === "text" || x.t === "code" ? x.v : x.t === "image" ? x.alt : x.t === "wikilink" ? wikiText(x) : x.t === "softbreak" || x.t === "hardbreak" ? " " : plain(x.c))).join("");

const escFor = (s: string, m: Mode) => (m.slot ? escSlot(s) : m.cell ? escCell(s) : escText(s));

/** A command around each segment that has text (a hard break cannot be inside a prose slot). */
const wrap = (segs: string[], open: string) => segs.map((s) => (s.trim() ? `[${open}: ${s}]` : s));

/** Inlines as segments split at hard breaks. */
const segments = (xs: Inline[], m: Mode): string[] => {
  const segs = [""];
  for (const x of xs) {
    if (x.t === "hardbreak") {
      segs.push("");
      continue;
    }
    const parts = one(x, m);
    segs[segs.length - 1] += parts[0];
    segs.push(...parts.slice(1));
  }
  return segs;
};

const one = (x: Inline, m: Mode): string[] => {
  const slot: Mode = { ...m, slot: true };
  switch (x.t) {
    case "text":
      return [escFor(x.v, m)];
    case "code":
      return x.v.trim() ? [`[code: ${escSlot(x.v)}]`] : [escFor(x.v, m)];
    case "strong":
      return wrap(segments(x.c, slot), "strong");
    case "em":
      return wrap(segments(x.c, slot), "italic");
    // Golem has no strikethrough in rc4: its text stays (docs/adr/0035)
    case "del":
      return segments(x.c, m);
    case "link": {
      const url = golemUrl(x.href);
      if (!url) return segments(x.c, m);
      const text = plain(x.c);
      if (!text.trim()) return [""];
      // an autolink: the URL alone
      if (text === x.href && url === x.href && x.c.length === 1) return [`[link ${quote(url)}]`];
      return wrap(segments(x.c, slot), `link ${quote(url)}`);
    }
    case "image":
      return [escFor(x.alt, m)];
    case "wikilink":
      return [escFor(wikiText(x), m)];
    case "softbreak":
      return [x.cjk ? (m.oneLine ? "" : "\n") : " "];
    case "hardbreak":
      return ["", ""];
  }
};

/** Segments joined by hard breaks, the empty ones dropped (Golem has no line without text, G02057). */
const joined = (segs: string[], cont = "") =>
  segs
    .map((s) => s.replace(/^[ \t]+|[ \t]+$/g, ""))
    .filter((s) => s.trim())
    .join(`\\\n${cont}`);

const paragraph = (xs: Inline[], sep: Separator): string =>
  joined(segments(xs, { slot: false, cell: false, oneLine: sep === "line" }))
    .split("\n")
    .map(guard)
    .join("\n");

// ---- figures ----

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;
const FIGURE_EXT = /\.(png|jpe?g|svg)$/i;

/** `a/b/../c` as `a/c`; null when it leaves the root. */
const normalize = (p: string): string | null => {
  const out: string[] = [];
  for (const s of p.split("/")) {
    if (!s || s === ".") continue;
    if (s === "..") {
      if (!out.length) return null;
      out.pop();
    } else out.push(s);
  }
  return out.join("/");
};

const decodePct = (s: string) =>
  s.replace(/(?:%[0-9A-Fa-f]{2})+/g, (m) => {
    try {
      return decodeURIComponent(m);
    } catch {
      return m;
    }
  });

/** An image Golem cannot place: its alt as text, and its path in a comment for the writer. */
const unplaced = (alt: string, src: string) => guard(`${alt ? escText(alt) + " " : ""}%% 画像: ${src.replace(/%%/g, "%25%25")} %%`);

const figureAt = (path: string, alt: string) => `@nonumber\n@figure ${quote(path)} alt=${quote(alt)}`;

/**
 * Where an image alone on its line goes (docs/adr/0061): a figure (PNG, JPEG or SVG in the project, its path from
 * the project's root), a link (a remote one), or nowhere (its alt stays, its path goes into a comment).
 */
export const placeImage = (src: string, dir: string | null): { k: "figure"; path: string } | { k: "link"; url: string } | { k: "none" } => {
  const s = src.trim();
  if (/^https?:/i.test(s)) {
    const url = golemUrl(s);
    return url ? { k: "link", url } : { k: "none" };
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith("/")) return { k: "none" };
  const p = decodePct(s.replace(/[?#][\s\S]*$/, ""));
  if (!FIGURE_EXT.test(p)) return { k: "none" };
  const path = dir === null ? p : normalize(`${dir}/${p}`);
  return path ? { k: "figure", path } : { k: "none" };
};

const image = (src: string, alt: string, ctx: GmCtx): string => {
  const at = placeImage(src, ctx.dir);
  if (at.k === "figure") return figureAt(at.path, alt);
  if (at.k === "link") return alt.trim() ? `[link ${quote(at.url)}: ${escSlot(alt)}]` : `[link ${quote(at.url)}]`;
  return unplaced(alt, src.trim());
};

const stemOf = (p: string) => (p.split("/").pop() ?? p).replace(/\.[^.]*$/, "");

// ---- blocks ----

const indent = (text: string, n: number) =>
  text
    .split("\n")
    .map((l) => (l ? " ".repeat(n) + l : l))
    .join("\n");

const table = (b: Block & { t: "table" }) => {
  const cell = (c: Inline[]) => joined(segments(c, { slot: false, cell: true, oneLine: true })).replace(/\\\n/g, " ");
  const row = (cs: Inline[][]) => `| ${cs.map(cell).join(" | ")} |`;
  const sep = `|${b.align.map((a) => (a === "left" ? ":---" : a === "right" ? "---:" : a === "center" ? ":---:" : "---")).join("|")}|`;
  return [row(b.head), sep, ...b.rows.map(row)].join("\n");
};

const code = (b: Block & { t: "code" }) => {
  const lang = /^[A-Za-z0-9_+-]+$/.test(b.lang) ? b.lang : "";
  // Golem closes a code block at ``` and spaces: such a line in the code keeps a space before it
  const body = b.text
    .split("\n")
    .map((l) => (/^```[ \t]*$/.test(l) ? ` ${l}` : l))
    .join("\n");
  return "```" + lang + "\n" + body + "\n```";
};

/** Golem numbers on across ordered lists a blank line apart: every ordered list after the first says its start. */
type State = { ordered: number };

const list = (b: Block & { t: "list" }, depth: number, sep: Separator, ctx: GmCtx, st: State): string => {
  const ind = "  ".repeat(depth);
  const out: string[] = [];
  if (b.ordered && (b.start !== 1 || st.ordered > 0)) out.push(`${ind}@number ${b.start}`);
  if (b.ordered) st.ordered++;
  for (const it of b.items) {
    const mark = `${ind}${b.ordered ? "+" : "-"} ${it.checked === undefined ? "" : it.checked ? "☑ " : "☐ "}`;
    const [first, ...rest] = it.c;
    const text =
      first?.t === "para" ? joined(segments(first.c, { slot: false, cell: false, oneLine: true }), `${ind}  `) : "";
    // an item with no text of its own (Golem cannot read "- " alone)
    out.push(text ? mark + guard(text) : `${mark}[= ""]`);
    for (const child of first?.t === "para" && text ? rest : it.c) {
      if (child.t === "list") out.push(list(child, depth + 1, sep, ctx, st));
      else {
        const g = block(child, sep, ctx, st, true);
        if (g !== null) out.push("", indent(g, (depth + 1) * 2));
      }
    }
  }
  return out.join("\n");
};

/** A block as gm; `nested` inside a quote or a list item, where headings become paragraphs. */
const block = (b: Block, sep: Separator, ctx: GmCtx, st: State, nested = false): string | null => {
  switch (b.t) {
    case "heading": {
      const text = joined(segments(b.c, { slot: false, cell: false, oneLine: true })).replace(/\\\n/g, " ");
      if (!text) return null;
      return nested ? guard(text) : `${"#".repeat(b.level)} ${text}`;
    }
    case "para":
      return paragraph(b.c, sep) || null;
    case "quote": {
      const parts = b.c.map((x) => block(x, sep, ctx, st, true)).filter((x): x is string => x !== null);
      return parts.length ? parts.join("\n\n") : null;
    }
    case "list":
      return list(b, 0, sep, ctx, st);
    case "code":
      return code(b);
    case "table":
      return table(b);
    case "hr":
    case "front":
      return null;
    case "image":
      return image(b.src, b.alt, ctx);
    // an embedded image is a figure; an embedded sheet leaves its name (docs/adr/0029)
    case "embed": {
      if (IMAGE_EXT.test(b.target)) {
        const found = ctx.resolveEmbed(b.target);
        const alt = stemOf(b.target);
        return found && FIGURE_EXT.test(found) ? figureAt(found, alt) : unplaced(alt, b.target);
      }
      const name = b.target || b.heading || "";
      return name ? guard(escText(name)) : null;
    }
  }
};

export const mdToGm = (md: string, sep: Separator, ctx: GmCtx = NO_CTX): string => {
  const st: State = { ordered: 0 };
  const parts = parseMarkdown(md.replace(CONTROL, ""))
    .map((b) => block(b, sep, ctx, st))
    .filter((x): x is string => x !== null && x !== "");
  return parts.length ? parts.join("\n\n") + "\n" : "";
};
