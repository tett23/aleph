// Markdown to Golem (docs/adr/0016), over the same reader as the Markdown preview.
import type { Separator } from "./manifest.ts";
import { parseMarkdown, wikiText, type Block, type Inline, type Line } from "./md.ts";

/** Running text: [ \ and %% are escaped, and ## before a digit (Golem's ##N## numbers). */
const escText = (s: string) => s.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/%%/g, "\\%%").replace(/##(?=[0-9])/g, "\\##");
/** Inside a prose slot ] and | also end or split the command. */
const escSlot = (s: string) => escText(s).replace(/\]/g, "\\]").replace(/\|/g, "\\|");

const inline = (xs: Inline[], slot: boolean): string =>
  xs
    .map((x) => {
      switch (x.t) {
        case "text":
          return slot ? escSlot(x.v) : escText(x.v);
        case "code":
          return `[code: ${escSlot(x.v)}]`;
        case "strong":
          return `[strong: ${inline(x.c, true)}]`;
        case "em":
          return `[italic: ${inline(x.c, true)}]`;
        case "link":
          return inline(x.c, slot);
        case "image":
          return slot ? escSlot(x.alt) : escText(x.alt);
        case "wikilink":
          return slot ? escSlot(wikiText(x)) : escText(wikiText(x));
      }
    })
    .join("");

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;

/** A line that would start a block in Golem keeps its first character as text. */
const guardStart = (line: string) => (/^[#\-+=@|]/.test(line) ? `\\${line}` : line);

const lines = (ls: Line[], sep: Separator): string => {
  const out: string[] = [];
  let cur = "";
  ls.forEach((l, i) => {
    const text = inline(l.c, false);
    const last = i === ls.length - 1;
    if (sep === "line") {
      // one paragraph, one line; a forced break keeps its line end
      cur += text;
      if (l.hard && !last) {
        out.push(guardStart(cur) + "\\");
        cur = "";
      }
    } else out.push(guardStart(text) + (l.hard && !last ? "\\" : ""));
  });
  if (sep === "line") out.push(guardStart(cur));
  return out.join("\n");
};

const block = (b: Block, sep: Separator): string | null => {
  switch (b.t) {
    case "heading":
      return `${"#".repeat(b.level)} ${inline(b.c, false)}`;
    case "para":
    case "quote":
      return lines(b.lines, sep);
    case "list":
      return b.items.map((it) => `${"  ".repeat(it.depth)}${it.ordered ? "+" : "-"} ${inline(it.c, false)}`).join("\n");
    case "code":
      return "```" + b.lang + "\n" + b.text + "\n```";
    case "table":
      return b.rows.join("\n");
    case "hr":
      return null;
    case "image":
      return `@figure ${b.src} alt="${b.alt.replace(/"/g, "")}"`;
    // an embedded image is a figure; an embedded sheet leaves its name (docs/adr/0029)
    case "embed":
      return IMAGE_EXT.test(b.target) ? `@figure ${b.target}` : escText(b.target || b.heading || "");
  }
};

export const mdToGm = (md: string, sep: Separator): string => {
  const parts = parseMarkdown(md)
    .map((b) => block(b, sep))
    .filter((x): x is string => x !== null);
  return parts.length ? parts.join("\n\n") + "\n" : "";
};
