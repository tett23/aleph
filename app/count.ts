// Counting a sheet (docs/adr/0012): characters without spaces, words by
// Intl.Segmenter, and manuscript sheets counted paragraph by paragraph.
import { gmBlocks } from "./gm.ts";
import type { Separator } from "./manifest.ts";
import { parseMarkdown, wikiText, type Inline } from "./md.ts";

export type Stats = { chars: number; words: number; sheets: number };
export type Manuscript = { cols: number; rows: number };

const inlineText = (xs: Inline[]): string =>
  xs.map((x) => (x.t === "text" || x.t === "code" ? x.v : x.t === "image" ? "" : x.t === "wikilink" ? wikiText(x) : inlineText(x.c))).join("");

/** The paragraphs of a sheet as plain text, by its kind. */
export const paragraphsOf = (kind: string, src: string, separator: Separator = "blank-line"): string[] => {
  if (kind === "gm") return gmBlocks(src, separator).flatMap((b) => (b.kind === "break" ? [] : [b.text]));
  if (kind === "md")
    return parseMarkdown(src)
      .flatMap((b) =>
        b.t === "heading" ? [inlineText(b.c)] : b.t === "para" || b.t === "quote" ? [b.lines.map((l) => inlineText(l.c)).join("")] : b.t === "list" ? b.items.map((i) => inlineText(i.c)) : [],
      )
      .filter((p) => p.trim());
  return src.split(separator === "line" ? /\n/ : /\n\s*\n/).map((p) => p.replace(/\n/g, "")).filter((p) => p.trim());
};

const words = new Intl.Segmenter("ja", { granularity: "word" });

export const stats = (paragraphs: string[], cols: number, rows: number): Stats => {
  const chars = paragraphs.reduce((a, p) => a + [...p.replace(/\s/g, "")].length, 0);
  let w = 0;
  for (const s of words.segment(paragraphs.join("\n"))) if (s.isWordLike) w++;
  // the same characters as the count: without spaces
  const lines = paragraphs.reduce((a, p) => a + Math.max(1, Math.ceil([...p.replace(/\s/g, "")].length / cols)), 0);
  return { chars, words: w, sheets: Math.round((lines / rows) * 10) / 10 };
};

export const countText = (kind: string, src: string, m: Manuscript, separator: Separator = "blank-line") => stats(paragraphsOf(kind, src, separator), m.cols, m.rows);
