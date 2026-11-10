// Files changed outside (docs/adr/0063), the decisions apart from the DOM: what a change
// on the disk means for an open sheet, whether a save may write, and the caret after
// the sheet takes the disk's text. They compare contents, not times.

/** `saved`: the text last read or written; `text`: the editor's; `disk`: the file's now (null when it is gone). */
export const classifyChange = (o: { saved: string; text: string; disk: string | null }): "none" | "reload" | "merge" | "gone" => {
  if (o.disk === null) return "gone";
  // the disk has what was saved (Aleph's own saves come back this way)
  if (o.disk === o.saved) return "none";
  return o.text === o.saved ? "reload" : "merge";
};

/** Before a save writes: only when the disk still has what was last read or written. */
export const saveCheck = (o: { saved: string; disk: string | null }): "write" | "changed" | "gone" =>
  o.disk === null ? "gone" : o.disk === o.saved ? "write" : "changed";

/** The caret at the same line and column of `next` (the last line when lines went, the line's end when shorter). */
export const caretAfter = (before: string, pos: number, next: string): number => {
  const head = before.slice(0, pos).split("\n");
  const line = head.length - 1;
  const col = head[head.length - 1].length;
  const ls = next.split("\n");
  const l = Math.min(line, ls.length - 1);
  let at = 0;
  for (let k = 0; k < l; k++) at += ls[k].length + 1;
  return at + Math.min(col, ls[l].length);
};
