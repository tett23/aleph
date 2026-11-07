// Positions between the document and the DOM of a drawn line (docs/adr/0019).
// A line holds text nodes inside spans, and elements to skip (gutters,
// invisible marks, widgets); the functions walk any tree through `Walk`, so the
// tests use plain objects and the editor real nodes.

export type Walk<N> = {
  isText: (n: N) => boolean;
  text: (n: N) => string;
  children: (n: N) => N[];
  skip: (n: N) => boolean;
};

/** The text node and offset for an offset in the line; the end of a node wins over the start of the next. */
export const offsetToDom = <N>(w: Walk<N>, line: N, offset: number): { node: N; offset: number } => {
  let rest = offset;
  let lastText: N | null = null;
  const visit = (n: N): { node: N; offset: number } | null => {
    if (w.skip(n)) return null;
    if (w.isText(n)) {
      const len = w.text(n).length;
      lastText = n;
      if (rest <= len) return { node: n, offset: rest };
      rest -= len;
      return null;
    }
    for (const c of w.children(n)) {
      const r = visit(c);
      if (r) return r;
    }
    return null;
  };
  const found = visit(line);
  if (found) return found;
  return lastText ? { node: lastText, offset: w.text(lastText).length } : { node: line, offset: 0 };
};

/** The offset in the line of a DOM position (a node and an offset in it, as the Selection API gives). */
export const domToOffset = <N>(w: Walk<N>, line: N, node: N, offset: number): number => {
  let count = 0;
  let done = false;
  const visit = (n: N, inSkip: boolean): void => {
    if (done) return;
    if (n === node) {
      if (w.isText(n)) count += inSkip ? 0 : offset;
      else w.children(n).slice(0, offset).forEach((c) => visit(c, inSkip || w.skip(n)));
      done = true;
      return;
    }
    if (w.isText(n)) {
      if (!inSkip) count += w.text(n).length;
      return;
    }
    const skip = inSkip || w.skip(n);
    for (const c of w.children(n)) {
      visit(c, skip);
      if (done) return;
    }
  };
  visit(line, false);
  return count;
};

/** The text of a drawn line as the DOM has it: skipped elements left out, a block inside it (put there by the browser) read as a line break. */
export const lineText = <N>(w: Walk<N>, line: N, isBlock: (n: N) => boolean): string => {
  const visit = (n: N, top: boolean): string => {
    if (w.skip(n)) return "";
    if (w.isText(n)) return w.text(n);
    const inner = w.children(n).map((c) => visit(c, false)).join("");
    return !top && isBlock(n) ? "\n" + inner : inner;
  };
  return visit(line, true);
};

/** The walk over the editor's real DOM: gutters and elements that cannot be edited (marks, page breaks) are skipped. */
export const domWalk: Walk<Node> = {
  isText: (n) => n.nodeType === 3,
  text: (n) => n.nodeValue ?? "",
  children: (n) => [...n.childNodes],
  skip: (n) => n instanceof HTMLElement && (n.contentEditable === "false" || n.classList.contains("ed-gut")),
};
