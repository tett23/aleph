// The arrow keys in vertical writing (docs/adr/0059): WebKit moves by line with
// ↑↓ and by character with ←→ whatever the writing mode, so the editor turns
// each key into the move it makes in horizontal writing, rotated: ↓ is →
// (forward along the line), ↑ is ←, ← is ↓ (to the next line), → is ↑.

export type ArrowKey = { key: string; shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean };

/** A move for Selection.modify. */
export type Modify = { alter: "move" | "extend"; direction: "forward" | "backward"; granularity: string };
/** A move to the document's start or end, which the editor makes itself (the lines may not be drawn). */
export type DocMove = { doc: "start" | "end"; extend: boolean };

const ALONG: Record<string, "forward" | "backward"> = { ArrowDown: "forward", ArrowUp: "backward" };
const ACROSS: Record<string, "forward" | "backward"> = { ArrowLeft: "forward", ArrowRight: "backward" };

/** How a key moves the caret in vertical writing, or null when it is left to the browser. */
export const verticalMove = (e: ArrowKey): Modify | DocMove | null => {
  if (e.ctrlKey || (e.metaKey && e.altKey)) return null;
  const alter = e.shiftKey ? "extend" : "move";
  const along = ALONG[e.key];
  if (along) return { alter, direction: along, granularity: e.metaKey ? "lineboundary" : e.altKey ? "word" : "character" };
  const across = ACROSS[e.key];
  if (!across) return null;
  if (e.metaKey) return { doc: across === "forward" ? "end" : "start", extend: e.shiftKey };
  return { alter, direction: across, granularity: e.altKey ? "paragraphboundary" : "line" };
};
