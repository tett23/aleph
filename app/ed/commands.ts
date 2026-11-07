// Editing commands without the DOM (docs/adr/0019).
import type { Text } from "./text.ts";

const UNIT = "  ";

/** Indents (dir 1) or unindents (dir -1) the lines a selection touches. */
export const indent = (doc: Text, sel: { from: number; to: number }, dir: 1 | -1) => {
  const first = doc.lineAt(sel.from).number;
  let last = doc.lineAt(sel.to).number;
  if (last > first && doc.line(last).from === sel.to) last--;
  const out: { from: number; to: number; insert: string }[] = [];
  for (let n = first; n <= last; n++) {
    const l = doc.line(n);
    if (dir > 0) out.push({ from: l.from, to: l.from, insert: UNIT });
    else {
      const m = /^(\t| {1,2})/.exec(l.text);
      if (m) out.push({ from: l.from, to: l.from + m[0].length, insert: "" });
    }
  }
  return out;
};

/** The completion items matching the word typed so far. */
export const filterItems = <T extends { label: string }>(items: T[], word: string): T[] =>
  items.filter((i) => i.label.toLowerCase().startsWith(word.toLowerCase()));
