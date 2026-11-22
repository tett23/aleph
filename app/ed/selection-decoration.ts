// Draw selection matches without putting wrappers or generated content in the editor (ADR 0102).
import { domWalk, offsetToDom } from "./dompos.ts";
import type { Range as Match } from "./spans.ts";
import type { Text } from "./text.ts";
import { linesOfRanges } from "./update.ts";

export const createSelectionDecoration = (root: HTMLElement) => {
  const surface = document.createElement("div");
  surface.className = "ed-selection-decoration";
  surface.setAttribute("aria-hidden", "true");
  root.append(surface);
  let cache: { doc: Text; matches: Match[]; lines: Map<number, Match[]> } | undefined;

  const draw = (doc: Text, matches: Match[], units: Iterable<{ line: number; el: HTMLElement }>, viewport: HTMLElement, vertical: boolean) => {
    if (!matches.length) {
      cache = undefined;
      if (surface.firstChild) surface.replaceChildren();
      return;
    }
    if (cache?.doc !== doc || cache.matches !== matches) cache = { doc, matches, lines: linesOfRanges(doc, matches, true) };
    const origin = surface.getBoundingClientRect();
    const port = viewport.getBoundingClientRect();
    const clip = {
      left: port.left + viewport.clientLeft,
      top: port.top + viewport.clientTop,
      right: port.left + viewport.clientLeft + viewport.clientWidth,
      bottom: port.top + viewport.clientTop + viewport.clientHeight,
    };
    const out = document.createDocumentFragment();
    const range = document.createRange();

    const paint = (left: number, top: number, right: number, bottom: number) => {
      if (right <= left || bottom <= top || right <= clip.left || bottom <= clip.top || left >= clip.right || top >= clip.bottom) return;
      const mark = document.createElement("div");
      mark.className = "ed-selmatch";
      const x = Math.max(left, clip.left);
      const y = Math.max(top, clip.top);
      mark.style.left = `${x - origin.left}px`;
      mark.style.top = `${y - origin.top}px`;
      mark.style.width = `${Math.min(right, clip.right) - x}px`;
      mark.style.height = `${Math.min(bottom, clip.bottom) - y}px`;
      out.append(mark);
    };

    for (const { line, el } of units) {
      const local = cache.lines.get(line);
      if (!local) continue;
      const box = el.getBoundingClientRect();
      if (box.right < clip.left || box.bottom < clip.top || box.left > clip.right || box.top > clip.bottom) continue;
      const length = doc.line(line).text.length;
      for (const match of local) {
        // The newline is between DOM lines, so draw it at the end caret.
        const to = offsetToDom(domWalk, el, Math.min(length, match.to));
        if (match.from < length) {
          const from = offsetToDom(domWalk, el, match.from);
          range.setStart(from.node, from.offset);
          range.setEnd(to.node, to.offset);
          for (const r of range.getClientRects()) paint(r.left, r.top, r.right, r.bottom);
        }
        if (match.to <= length) continue;
        range.setStart(to.node, to.offset);
        range.collapse(true);
        const caret = range.getClientRects()[0] ?? box;
        if (vertical) paint(caret.left, caret.top, caret.right, caret.top + 6);
        else paint(caret.left, caret.top, caret.left + 6, caret.bottom);
      }
    }
    surface.replaceChildren(out);
  };

  return { draw };
};
