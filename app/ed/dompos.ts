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

/**
 * The text of the editor's children `nodes` that stand between two drawn lines, as lines: a block is a
 * line (read as `lineText` reads it), and loose text up to a <br> or a block is a line too. WebKit can take
 * an empty line's element away while composing and leave the committed text and its <br> in the content.
 */
export const regionText = <N>(w: Walk<N>, nodes: N[], isBlock: (n: N) => boolean, isBreak: (n: N) => boolean): string => {
  const lines: string[] = [];
  let loose: string | null = null;
  const flush = () => {
    if (loose !== null) lines.push(loose);
    loose = null;
  };
  for (const n of nodes) {
    if (w.skip(n)) continue;
    if (isBlock(n)) {
      flush();
      lines.push(lineText(w, n, isBlock));
    } else if (isBreak(n)) {
      lines.push(loose ?? "");
      loose = null;
    } else loose = (loose ?? "") + lineText(w, n, isBlock);
  }
  flush();
  // a lone <br> is an empty line, as is nothing at all
  return lines.length ? lines.join("\n") : "";
};

/** The walk over the editor's real DOM: gutters and elements that cannot be edited (marks, page breaks) are skipped. */
export const domWalk: Walk<Node> = {
  isText: (n) => n.nodeType === 3,
  text: (n) => n.nodeValue ?? "",
  children: (n) => [...n.childNodes],
  skip: (n) => n instanceof HTMLElement && (n.contentEditable === "false" || n.classList.contains("ed-gut")),
};

/**
 * For a position between the editor's children (`offset`, as the Selection API gives it), the drawn
 * line to use: the line right after it (its start) or right before it (its end), else the nearest line
 * before (its end), else the nearest after (its start).
 */
export const nearestLine = (isLine: boolean[], offset: number): { index: number; end: boolean } | null => {
  if (isLine[offset]) return { index: offset, end: false };
  if (isLine[offset - 1]) return { index: offset - 1, end: true };
  for (let i = Math.min(offset - 1, isLine.length - 1); i >= 0; i--) if (isLine[i]) return { index: i, end: true };
  for (let i = offset; i < isLine.length; i++) if (isLine[i]) return { index: i, end: false };
  return null;
};
