import { test } from "node:test";
import assert from "node:assert/strict";
import { inputChange } from "./input.ts";
import { textOf } from "./text.ts";

const doc = textOf("ab🌊 cd\nef gh");
const apply = (r: ReturnType<typeof inputChange>): { text: string; sel: number; kind: string } | null => {
  if (!r || !("changes" in r)) return null;
  let s = doc.toString();
  for (const p of [...r.changes].reverse()) s = s.slice(0, p.from) + p.insert + s.slice(p.to);
  return { text: s, sel: r.sel, kind: r.kind };
};

test("typing inserts at the caret or replaces the selection", () => {
  assert.deepEqual(apply(inputChange({ inputType: "insertText", data: "X" }, { from: 2, to: 2 }, doc)), { text: "abX🌊 cd\nef gh", sel: 3, kind: "input.type" });
  assert.deepEqual(apply(inputChange({ inputType: "insertText", data: "X" }, { from: 1, to: 4 }, doc)), { text: "aX cd\nef gh", sel: 2, kind: "input.type" });
});

test("Enter inserts a newline", () => {
  assert.equal(apply(inputChange({ inputType: "insertParagraph" }, { from: 5, to: 5 }, doc))!.text, "ab🌊 \ncd\nef gh");
  assert.equal(apply(inputChange({ inputType: "insertLineBreak" }, { from: 0, to: 0 }, doc))!.text, "\nab🌊 cd\nef gh");
});

test("backspace and delete remove one grapheme, never half a surrogate pair", () => {
  assert.equal(apply(inputChange({ inputType: "deleteContentBackward" }, { from: 4, to: 4 }, doc))!.text, "ab cd\nef gh");
  assert.equal(apply(inputChange({ inputType: "deleteContentForward" }, { from: 2, to: 2 }, doc))!.text, "ab cd\nef gh");
  assert.equal(apply(inputChange({ inputType: "deleteContentBackward" }, { from: 0, to: 0 }, doc)), null);
  // across the line break
  assert.equal(apply(inputChange({ inputType: "deleteContentBackward" }, { from: 8, to: 8 }, doc))!.text, "ab🌊 cdef gh");
  assert.equal(apply(inputChange({ inputType: "deleteContentBackward" }, { from: 1, to: 6 }, doc))!.text, "ad\nef gh");
});

test("word and line deletions", () => {
  assert.equal(apply(inputChange({ inputType: "deleteWordBackward" }, { from: 13, to: 13 }, doc))!.text, "ab🌊 cd\nef ");
  assert.equal(apply(inputChange({ inputType: "deleteSoftLineBackward" }, { from: 13, to: 13 }, doc))!.text, "ab🌊 cd\n");
  assert.equal(apply(inputChange({ inputType: "deleteHardLineForward" }, { from: 2, to: 2 }, doc))!.text, "ab\nef gh");
});

test("paste inserts the plain text, with CRLF made LF", () => {
  assert.equal(apply(inputChange({ inputType: "insertFromPaste", data: "x\r\ny" }, { from: 0, to: 0 }, doc))!.text, "x\nyab🌊 cd\nef gh");
});

test("undo and redo are commands; composition is left to the browser", () => {
  assert.deepEqual(inputChange({ inputType: "historyUndo" }, { from: 0, to: 0 }, doc), { command: "undo" });
  assert.deepEqual(inputChange({ inputType: "historyRedo" }, { from: 0, to: 0 }, doc), { command: "redo" });
  assert.deepEqual(inputChange({ inputType: "insertCompositionText", data: "か" }, { from: 0, to: 0 }, doc), { command: "compose" });
});
