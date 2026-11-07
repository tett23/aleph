// Embeds in Markdown sheets (docs/adr/0029): a whole line ![[target#heading]]
// is drawn in the preview as the target's text (or the heading's section),
// nested up to three levels, without loops, within a total of 200,000
// characters. Reading files is done by the caller; this is pure.
import { esc } from "./esc.ts";
import { markdownHtml, wikiText, type Breaks } from "./md.ts";

export { embedOf } from "./md.ts";

const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i;
const DEPTH = 3;
const BUDGET = 200_000;

/** A heading's section: from its line to the next heading of the same or a higher level; null when not found. */
export const sectionOf = (text: string, kind: string, heading: string): string | null => {
  if (kind !== "md" && kind !== "gm") return null;
  const lines = text.split("\n");
  const want = heading.trim().normalize("NFC");
  let fence = false;
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*(```|~~~)/.test(l)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l);
    if (!m) continue;
    if (start < 0) {
      if (m[2].normalize("NFC") === want) (start = i), (level = m[1].length);
    } else if (m[1].length <= level) return lines.slice(start, i).join("\n").replace(/\n+$/, "");
  }
  return start < 0 ? null : lines.slice(start).join("\n").replace(/\n+$/, "");
};

export type EmbedIo = {
  /** The path a target names from a sheet (docs/adr/0027's rules), or null. */
  resolve: (target: string, from: string) => string | null;
  /** A sheet's text (the editor's for open ones), or null when it cannot be read. */
  read: (path: string) => string | null;
  /** A .gm's text without commands (the preview's plainHtml). */
  plain: (src: string) => string;
  /** How the Markdown's newlines are drawn (docs/adr/0035). */
  breaks?: Breaks;
  /** A sheet's name (its first heading), or null; without it the written target titles the frame (docs/adr/0039). */
  name?: (path: string) => string | null;
};

const note = (s: string) => `<div class="embed-note">${esc(s)}</div>`;

/** A frame; `title` is HTML already escaped. */
const frame = (path: string | null, title: string, heading: string | null, body: string) =>
  `<div class="embed"><div class="embed-head"${path ? ` data-embed-open="${esc(path)}"` : ""}${heading ? ` data-embed-heading="${esc(heading)}"` : ""}>${title}</div><div class="embed-body">${body}</div></div>`;

const fileName = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const stem = (p: string) => fileName(p).replace(/\.[^.]+$/, "");

/**
 * A frame's title: the sheet's name (else its file name) with " > heading", the
 * written target beside it when it differs; the written target when not found.
 */
const titleOf = (io: EmbedIo, target: string, heading: string | null, to: string | null) => {
  if (!to || !io.name) return esc(wikiText({ target, heading, text: null }));
  if (IMAGE.test(to)) return esc(fileName(to));
  const name = io.name(to) ?? stem(to);
  const aside = target && target !== name ? `<small class="embed-target">${esc(target)}</small>` : "";
  return esc(heading ? `${name} > ${heading}` : name) + aside;
};

/** A Markdown sheet's HTML with its embeds drawn in place. */
export const expandEmbeds = (src: string, path: string, io: EmbedIo): string => {
  let left = BUDGET;
  const take = (text: string): [string, boolean] => {
    if (text.length <= left) return (left -= text.length), [text, false];
    const part = text.slice(0, Math.max(0, left));
    left = 0;
    return [part, true];
  };
  const draw = (text: string, at: string, stack: string[]): string =>
    markdownHtml(text, {
      breaks: io.breaks,
      embed: (target, heading) => {
      const to = target ? io.resolve(target, at) : at;
      const title = titleOf(io, target, heading, to);
      if (!to) return frame(null, title, heading, note(`（見つかりません：${target}）`));
      if (IMAGE.test(to)) return frame(to, title, null, `<img data-src="${esc(to)}" alt="${esc(fileName(to))}">`);
      if (stack.includes(to)) return frame(to, title, heading, note("（循環のため埋め込みません）"));
      if (stack.length > DEPTH) return frame(to, title, heading, note("（入れ子が深すぎるため埋め込みません）"));
      const whole = io.read(to);
      if (whole === null) return frame(to, title, heading, note(`（読めません：${target}）`));
      const kind = to.slice(to.lastIndexOf(".") + 1);
      const part = heading ? sectionOf(whole, kind, heading) : whole;
      if (part === null) return frame(to, title, heading, note(`（見出しが見つかりません：${heading}）`));
      const [body, cut] = take(part);
      const html = kind === "md" ? draw(body, to, [...stack, to]) : kind === "gm" ? io.plain(body) : `<pre>${esc(body)}</pre>`;
      return frame(to, title, heading, html + (cut ? note("（長すぎるため省きました）") : ""));
      },
    });
  return draw(src, path, [path]);
};
