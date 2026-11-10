// Files changed outside (docs/adr/0063): what to do with a change, a save, and the caret.
import { test } from "node:test";
import assert from "node:assert/strict";
import { caretAfter, classifyChange, saveCheck } from "./watch.ts";

test("a change from outside: nothing when the disk has what was saved; reload without edits; merge with edits; gone without the file", () => {
  assert.equal(classifyChange({ saved: "a", text: "a", disk: "a" }), "none");
  assert.equal(classifyChange({ saved: "a", text: "ab", disk: "a" }), "none");
  assert.equal(classifyChange({ saved: "a", text: "a", disk: "b" }), "reload");
  assert.equal(classifyChange({ saved: "a", text: "ab", disk: "b" }), "merge");
  assert.equal(classifyChange({ saved: "a", text: "a", disk: null }), "gone");
  assert.equal(classifyChange({ saved: "a", text: "ab", disk: null }), "gone");
});

test("before a save: write when the disk has what was saved; otherwise not", () => {
  assert.equal(saveCheck({ saved: "a", disk: "a" }), "write");
  assert.equal(saveCheck({ saved: "a", disk: "b" }), "changed");
  assert.equal(saveCheck({ saved: "a", disk: null }), "gone");
});

test("the caret after a reload: the same line and column; the last line when lines went; the line's end when it is shorter", () => {
  const before = "一行目\n二行目です\n三行目";
  // line 2, column 3
  const pos = before.indexOf("です");
  assert.equal(caretAfter(before, pos, "一行目\n二行目を直しました\n三行目"), "一行目\n二行".length + 1);
  assert.equal(caretAfter(before, before.length, "一行目"), "一行目".length);
  assert.equal(caretAfter(before, pos, "一行目\nに\n三行目"), "一行目\nに".length);
  assert.equal(caretAfter("", 0, "abc"), 0);
});
