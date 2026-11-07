// Reading a chapter's XHTML with the browser's parser into the tree the
// sanitizer rebuilds from (docs/adr/0043). Read as HTML, so a broken file
// still gives its text; nothing parsed here reaches the page as it is.
import { sanitize, type ChapterBody, type Place, type XNode } from "./xhtml.ts";

const tree = (n: Node): XNode[] => {
  if (n.nodeType === Node.TEXT_NODE) return [{ kind: "text", text: n.textContent ?? "" }];
  if (n.nodeType !== Node.ELEMENT_NODE) return [];
  const el = n as Element;
  return [{ kind: "el", tag: el.tagName.toLowerCase(), attrs: [...el.attributes].map((a) => [a.name, a.value]), children: [...el.childNodes].flatMap(tree) }];
};

export const chapterBody = (xhtml: string, place: Place): ChapterBody => {
  if (!/<body\b/i.test(xhtml)) return { html: "", images: [] };
  const body = new DOMParser().parseFromString(xhtml, "text/html").body;
  return sanitize([...body.childNodes].flatMap(tree), place);
};
