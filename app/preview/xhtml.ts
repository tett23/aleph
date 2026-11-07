// The body of a chapter's XHTML from golem build --target html (docs/adr/0010),
// without scripts, styles, links and event attributes. Written over strings so
// it runs without a DOM; Golem's output is well-formed XHTML.

export type ChapterBody = { html: string; images: string[] };

export const xhtmlPath = (project: string, path: string) => `${project}/build/html/${path.slice(project.length + 1).replace(/\.gm$/, ".xhtml")}`;

export const chapterBody = (xhtml: string): ChapterBody => {
  const m = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(xhtml);
  if (!m) return { html: "", images: [] };
  const html = m[1]
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<(script|style|link)\b[^>]*\/?>/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, "")
    .replace(/(href|src)\s*=\s*"\s*javascript:[^"]*"/gi, '$1="#"')
    .trim();
  const images = [...html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/gi)].map((x) => x[1]);
  return { html, images };
};
