// The body of a chapter's XHTML from golem build --target html (docs/adr/0010),
// rebuilt from a tree with only the tags and attributes Golem writes
// (docs/adr/0043). The tree comes from DOMParser in the app (xhtmldom.ts);
// this part takes the tree, so it runs without a DOM.
import { esc } from "../esc.ts";
import { resolve } from "../path.ts";

export type ChapterBody = { html: string; images: string[] };

/** An element or a text, as read from the XHTML. */
export type XNode = { kind: "text"; text: string } | { kind: "el"; tag: string; attrs: [string, string][]; children: XNode[] };

/** Where the XHTML is (its directory) and the build/html its images must stay under. */
export type Place = { dir: string; root: string };

export const xhtmlPath = (project: string, path: string) => `${project}/build/html/${path.slice(project.length + 1).replace(/\.gm$/, ".xhtml")}`;

const KEPT = new Set([
  "section", "div", "p", "span", "h1", "h2", "h3", "h4", "h5", "h6", "a", "em", "strong", "i", "b",
  "ruby", "rt", "rp", "br", "hr", "ul", "ol", "li", "blockquote", "pre", "code",
  "table", "thead", "tbody", "tr", "th", "td", "figure", "figcaption", "img", "sup", "sub", "small",
  "details", "summary",
]);
/** Dropped with all they hold. */
const DROPPED = new Set(["script", "style", "iframe", "object", "embed", "form", "base", "meta", "link", "template", "noscript", "head", "title"]);
const VOID = new Set(["br", "hr", "img"]);
const ATTRS = new Set(["class", "id", "lang", "dir", "title", "alt", "colspan", "rowspan"]);

/** Browsers skip spaces and control characters inside a URL's scheme. */
const squeeze = (v: string) => v.replace(/[\x00-\x20\x7f]/g, "");
const scheme = (v: string) => /^([a-z][a-z0-9+.-]*):/i.exec(squeeze(v))?.[1].toLowerCase() ?? null;
const relative = (v: string) => scheme(v) === null && !squeeze(v).startsWith("//") && !squeeze(v).startsWith("/");

const hrefOk = (v: string) => {
  const s = scheme(v);
  return squeeze(v).startsWith("#") || relative(v) || s === "http" || s === "https";
};

/** The absolute path of an image, when it stays under build/html. */
const imagePath = (src: string, place: Place) => {
  if (!relative(src)) return null;
  const p = resolve(place.dir, src.trim());
  return p.startsWith(`${place.root}/`) ? p : null;
};

export const sanitize = (nodes: XNode[], place: Place): ChapterBody => {
  const images: string[] = [];
  const walk = (n: XNode): string => {
    if (n.kind === "text") return esc(n.text);
    const tag = n.tag.toLowerCase();
    if (DROPPED.has(tag)) return "";
    const inner = () => n.children.map(walk).join("");
    if (!KEPT.has(tag)) return inner();
    const attrs: string[] = [];
    const get = (name: string) => n.attrs.find(([k]) => k.toLowerCase() === name)?.[1];
    for (const [k, v] of n.attrs) {
      const name = k.toLowerCase();
      if (ATTRS.has(name)) attrs.push(`${name}="${esc(v)}"`);
      else if (name === "epub:type") attrs.push(`data-epub-type="${esc(v)}"`);
      else if (name === "href" && tag === "a" && hrefOk(v)) attrs.push(`href="${esc(v.trim())}"`);
      else if (name === "open" && tag === "details") attrs.push(`open=""`);
    }
    if (tag === "img") {
      const p = imagePath(get("src") ?? "", place);
      if (!p) return `<span class="img-alt">${esc(get("alt") ?? "")}</span>`;
      images.push(p);
      attrs.push(`data-src="${esc(p)}"`);
    }
    const open = `<${tag}${attrs.map((a) => ` ${a}`).join("")}>`;
    return VOID.has(tag) ? open : `${open}${inner()}</${tag}>`;
  };
  return { html: nodes.map(walk).join("").trim(), images };
};
