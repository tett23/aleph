import { test } from "node:test";
import assert from "node:assert/strict";
import { textOf } from "./text.ts";

test("lines of a text: count, starts and ends, with a final newline", () => {
  const t = textOf("一行目\n二\n");
  assert.equal(t.lines, 3);
  assert.deepEqual(t.line(1), { number: 1, from: 0, to: 3, text: "一行目" });
  assert.deepEqual(t.line(2), { number: 2, from: 4, to: 5, text: "二" });
  assert.deepEqual(t.line(3), { number: 3, from: 6, to: 6, text: "" });
  assert.equal(t.length, 6);
});

test("an empty text has one empty line", () => {
  const t = textOf("");
  assert.equal(t.lines, 1);
  assert.deepEqual(t.line(1), { number: 1, from: 0, to: 0, text: "" });
});

test("the line at a position; a position on a newline belongs to the line it ends", () => {
  const t = textOf("ab\ncd\n");
  assert.equal(t.lineAt(0).number, 1);
  assert.equal(t.lineAt(2).number, 1);
  assert.equal(t.lineAt(3).number, 2);
  assert.equal(t.lineAt(6).number, 3);
  assert.equal(t.lineAt(99).number, 3);
});

test("positions are UTF-16 units: surrogate pairs count two", () => {
  const t = textOf("🌊海\nx");
  assert.equal(t.line(1).to, 3);
  assert.equal(t.lineAt(4).number, 2);
  assert.equal(t.slice(0, 2), "🌊");
});

test("replacing gives a new text and keeps the old one", () => {
  const a = textOf("ab\ncd");
  const b = a.replace(1, 4, "X\nY");
  assert.equal(b.toString(), "aX\nYd");
  assert.equal(b.lines, 2);
  assert.equal(a.toString(), "ab\ncd");
});
