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

// ---- the file characters beside the body characters (docs/adr/0075) ----

/** The sheets with a body to count; other kinds (PDF and other binary or data files) show no text counts. */
export const PROSE_KINDS = ["gm", "md", "txt"];

/** The file characters: every Unicode code point of the buffer, marks, comments, spaces and newlines included. */
export const fileChars = (src: string): number => [...src].length;

export type SheetCounts = Stats & { fileChars: number };

/** The counts of a sheet's buffer, or null when the sheet has no body to count. */
export const sheetCounts = (kind: string, src: string, m: Manuscript, separator: Separator = "blank-line"): SheetCounts | null =>
  PROSE_KINDS.includes(kind) ? { ...countText(kind, src, m, separator), fileChars: fileChars(src) } : null;

/** The progress toward a goal: by the body characters, never the file characters. */
export const goalProgress = (c: Stats, goal: number | null): number => (goal ? c.chars / goal : 0);

/** The status bar items of a sheet's counts. */
export const countsStatus = (c: SheetCounts): string =>
  `<span>本文文字数 ${c.chars.toLocaleString()}</span><span>ファイル文字数 ${c.fileChars.toLocaleString()}</span><span>${c.words.toLocaleString()} 語</span><span>原稿用紙 ${c.sheets} 枚</span>`;
