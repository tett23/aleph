// Markdown AST types and preview HTML rendering. Rust parses the source into
// these blocks and inlines (docs/adr/0116); HTML in the source stays text.
import { api } from "./api.ts";
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
  | { t: "wikilink"; target: string; heading: string | null; text: string | null };

/** A list item; `checked` only for a task list item (docs/adr/0035). */
export type ListItem = { depth: number; ordered: boolean; c: Inline[]; checked?: boolean };

/** How a paragraph's newlines are drawn (docs/adr/0035). */
export type Breaks = "newline" | "blank-line";

/** A line of a paragraph or quote, and whether it ends in a hard break (two spaces or a backslash). */
export type Line = { c: Inline[]; hard: boolean };

export type Block =
  | { t: "heading"; level: number; c: Inline[] }
  | { t: "para"; lines: Line[] }
  | { t: "quote"; lines: Line[] }
  | { t: "list"; items: ListItem[] }
  | { t: "code"; lang: string; text: string }
  | { t: "table"; rows: string[] }
  | { t: "hr" }
  | { t: "image"; src: string; alt: string }
  /** A whole line `![[target#heading]]` (docs/adr/0029). */
  | { t: "embed"; target: string; heading: string | null };

// ---- HTML, for the preview ----

const safeUrl = (u: string) => (/^\s*(javascript|vbscript|data):/i.test(u) ? "#" : u);

/** What a wikilink shows: its label, or the target (with " > heading"). */
export const wikiText = (x: { target: string; heading: string | null; text: string | null }) =>
  x.text ?? (x.heading ? (x.target ? `${x.target} > ${x.heading}` : x.heading) : x.target);

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
        case "del":
          return `<del>${inlineHtml(x.c)}</del>`;
        case "link":
          return `<a href="${esc(safeUrl(x.href))}">${inlineHtml(x.c)}</a>`;
        case "image":
          return `<img src="${esc(safeUrl(x.src))}" alt="${esc(x.alt)}">`;
        case "wikilink":
          return `<a class="wikilink" data-wikilink="${esc(x.target)}"${x.heading ? ` data-heading="${esc(x.heading)}"` : ""} href="#">${esc(wikiText(x))}</a>`;
      }
    })
    .join("");

const plainOf = (xs: Inline[]): string =>
  xs.map((x) => (x.t === "text" || x.t === "code" ? x.v : x.t === "image" ? x.alt : x.t === "wikilink" ? wikiText(x) : plainOf(x.c))).join("");

/** Characters around which a soft break draws no space (CSS Text's segment break transformation). */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3000-\u303F\uFF00-\uFFEF]/u;

const linesHtml = (ls: Line[], breaks: Breaks) =>
  ls
    .map((l, n) => {
      if (n === ls.length - 1) return inlineHtml(l.c);
      if (breaks === "newline" || l.hard) return inlineHtml(l.c) + "<br>";
      const a = [...plainOf(l.c)].pop() ?? "";
      const b = [...plainOf(ls[n + 1].c)][0] ?? "";
      return inlineHtml(l.c) + (CJK.test(a) || CJK.test(b) ? "" : "\n");
    })
    .join("");

const listHtml = (items: ListItem[]): string => {
  let html = "";
  const stack: boolean[] = [];
  for (const it of items) {
    while (stack.length > it.depth + 1) html += `</li></${stack.pop() ? "ol" : "ul"}>`;
    if (stack.length === it.depth + 1) html += "</li>";
    while (stack.length < it.depth + 1) {
      stack.push(it.ordered);
      html += it.ordered ? "<ol>" : "<ul>";
    }
    const box = it.checked === undefined ? "" : `<input type="checkbox"${it.checked ? " checked" : ""} disabled> `;
    html += `<li>${box}${inlineHtml(it.c)}`;
  }
  while (stack.length) html += `</li></${stack.pop() ? "ol" : "ul"}>`;
  return html;
};

/** An embed as a link to its target, where nothing expands it (docs/adr/0029 expands it in the preview). */
const embedLink = (target: string, heading: string | null) =>
  `<p><a class="wikilink" data-wikilink="${esc(target)}"${heading ? ` data-heading="${esc(heading)}"` : ""} href="#">${esc(wikiText({ target, heading, text: null }))}</a></p>`;

const alignAttr = (a: string | null | undefined) => (a ? ` style="text-align:${a}"` : "");

/** Where a sheet is and the workspace its images must stay in (docs/adr/0047). */
export type ImageBase = { dir: string; root: string };

export type HtmlOptions = { embed?: (target: string, heading: string | null) => string | Promise<string>; breaks?: Breaks; base?: ImageBase };

const unesc = (s: string) => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[e]!);

/** An image the preview reads from the workspace, or a note in its place; remote images are never loaded. */
const imageHtml = (src: string, alt: string, base: ImageBase | undefined) => {
  const s = src.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith("//")) return `<span class="img-note">${esc(alt)}（外部の画像は読み込みません：${esc(s)}）</span>`;
  const p = base ? within(base.root, base.dir, s) : null;
  return p ? `<img data-src="${esc(p)}" alt="${esc(alt)}">` : `<span class="img-note">${esc(alt)}（ワークスペースの外の画像は読み込みません）</span>`;
};

/** Renders the AST supplied by Rust's Markdown parser. */
export const markdownHtmlBlocks = async (blocks: Block[], { embed = embedLink, breaks = "blank-line", base }: HtmlOptions = {}): Promise<string> => {
  const parts: string[] = [];
  for (const b of blocks) {
    switch (b.t) {
      case "heading":
        parts.push(`<h${b.level}>${inlineHtml(b.c)}</h${b.level}>`);
        break;
      case "para":
        parts.push(`<p>${linesHtml(b.lines, breaks)}</p>`);
        break;
      case "quote":
        parts.push(`<blockquote><p>${linesHtml(b.lines, breaks)}</p></blockquote>`);
        break;
      case "list":
        parts.push(listHtml(b.items));
        break;
      case "code":
        parts.push(`<pre><code${b.lang ? ` class="language-${esc(b.lang)}"` : ""}>${esc(b.text)}</code></pre>`);
        break;
      case "table": {
        const table = await api.parseMarkdownTable(b.rows);
        const row = (cells: Inline[][], tag: "th" | "td") =>
          `<tr>${cells.map((cell, k) => `<${tag}${alignAttr(table.aligns[k])}>${inlineHtml(cell)}</${tag}>`).join("")}</tr>`;
        parts.push(`<table><thead>${row(table.head, "th")}</thead><tbody>${table.body.map((cells) => row(cells, "td")).join("")}</tbody></table>`);
        break;
      }
      case "hr":
        parts.push("<hr>");
        break;
      case "image":
        parts.push(`<p><img src="${esc(safeUrl(b.src))}" alt="${esc(b.alt)}"></p>`);
        break;
      case "embed":
        parts.push(await embed(b.target, b.heading));
        break;
    }
  }
  return parts.join("\n").replace(/<img src="([^"]*)" alt="([^"]*)">/g, (_, s: string, a: string) => imageHtml(unesc(s), unesc(a), base));
};

/** Markdown rendering uses the Rust parser for blocks and table cells. */
export const markdownHtml = async (src: string, options: HtmlOptions = {}): Promise<string> =>
  markdownHtmlBlocks(await api.parseMarkdown(src), options);
