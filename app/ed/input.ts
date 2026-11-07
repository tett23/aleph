// What a beforeinput event does to the document (docs/adr/0019). The editor
// prevents the browser's own change and applies this one instead; composition
// (IME) is left to the browser and taken in when it ends (ime.ts).
import type { Text } from "./text.ts";

export type InputLike = { inputType: string; data?: string | null };
export type Result = { changes: { from: number; to: number; insert: string }[]; sel: number; kind: string } | { command: "undo" | "redo" | "compose" } | null;

const graphemes = new Intl.Segmenter("ja", { granularity: "grapheme" });
const words = new Intl.Segmenter("ja", { granularity: "word" });

const prevGrapheme = (s: string, pos: number) => {
  let last = 0;
  for (const g of graphemes.segment(s)) {
    if (g.index >= pos) break;
    last = g.index;
  }
  return last;
};
const nextGrapheme = (s: string, pos: number) => {
  for (const g of graphemes.segment(s)) if (g.index >= pos) return g.index + g.segment.length;
  return s.length;
};

export const inputChange = (e: InputLike, sel: { from: number; to: number }, doc: Text): Result => {
  const { from, to } = sel;
  const replace = (a: number, b: number, insert: string, kind: string): Result =>
    a === b && !insert ? null : { changes: [{ from: a, to: b, insert }], sel: a + insert.length, kind };
  const text = doc.toString();
  const line = doc.lineAt(from);
  switch (e.inputType) {
    case "insertText":
    case "insertReplacementText":
      return replace(from, to, e.data ?? "", "input.type");
    case "insertParagraph":
    case "insertLineBreak":
      return replace(from, to, "\n", "input.type");
    case "insertFromPaste":
    case "insertFromDrop":
    case "insertFromYank":
      return replace(from, to, (e.data ?? "").replace(/\r\n?/g, "\n"), "input.paste");
    case "deleteByCut":
    case "deleteContent":
      return replace(from, to, "", "input.delete");
  }
  if (e.inputType.startsWith("delete") && from !== to) return replace(from, to, "", "input.delete");
  switch (e.inputType) {
    case "deleteContentBackward":
      return from === 0 ? null : replace(prevGrapheme(text, from), from, "", "input.delete");
    case "deleteContentForward":
      return from === text.length ? null : replace(from, nextGrapheme(text, from), "", "input.delete");
    case "deleteWordBackward": {
      if (from === line.from) return from === 0 ? null : replace(from - 1, from, "", "input.delete");
      let start = line.from;
      for (const w of words.segment(line.text.slice(0, from - line.from))) if (w.isWordLike) start = line.from + w.index;
      return replace(start, from, "", "input.delete");
    }
    case "deleteWordForward": {
      if (from === line.to) return from === text.length ? null : replace(from, from + 1, "", "input.delete");
      const rest = line.text.slice(from - line.from);
      const w = [...words.segment(rest)].find((x) => x.isWordLike);
      return replace(from, w ? from + w.index + w.segment.length : line.to, "", "input.delete");
    }
    case "deleteSoftLineBackward":
    case "deleteHardLineBackward":
      return replace(line.from, from, "", "input.delete");
    case "deleteSoftLineForward":
    case "deleteHardLineForward":
      return replace(from, line.to, "", "input.delete");
    case "historyUndo":
      return { command: "undo" };
    case "historyRedo":
      return { command: "redo" };
    case "insertCompositionText":
    case "deleteCompositionText":
    case "insertFromComposition":
      return { command: "compose" };
  }
  return null;
};
