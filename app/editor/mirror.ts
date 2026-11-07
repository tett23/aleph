// The mirror layer behind the vertical editor: one block per source line, with
// its line number and change mark shown above the line (docs/adr/0007).
import type { LineMark } from "../diff.ts";
import { esc } from "../esc.ts";

/** The mirror's HTML. Empty lines keep a zero-width space so that they take a column. */
export const mirrorHtml = (text: string, marks: Map<number, LineMark>) =>
  text
    .split("\n")
    .map((l, i) => {
      const m = marks.get(i);
      return `<div class="vl" data-n="${i + 1}"${m ? ` data-m="${m}"` : ""}>${esc(l) || "​"}</div>`;
    })
    .join("");

/** The offset of the start of a 1-based line, for moving the caret. */
export const lineOffset = (text: string, line: number) =>
  text
    .split("\n")
    .slice(0, Math.max(0, line - 1))
    .reduce((a, l) => a + l.length + 1, 0);
