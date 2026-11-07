import { test } from "node:test";
import assert from "node:assert/strict";
import { invisibleRanges, lineSpans, specialRanges } from "./spans.ts";

const show = (text: string, layers: Parameters<typeof lineSpans>[1]) => lineSpans(text, layers).map((s) => [text.slice(s.from, s.to), s.cls.join(" ")]);

test("layers split the line at every boundary; classes stack in layer order", () => {
  assert.deepEqual(show("abcdef", [[{ from: 1, to: 4, cls: "t-cmd" }], [{ from: 3, to: 5, cls: "d-error" }]]), [
    ["a", ""], ["bc", "t-cmd"], ["d", "t-cmd d-error"], ["e", "d-error"], ["f", ""],
  ]);
});

test("ranges outside the line are clipped; a range across the line's end ends at the end", () => {
  assert.deepEqual(show("abc", [[{ from: -2, to: 1, cls: "x" }, { from: 2, to: 9, cls: "y" }]]), [["a", "x"], ["b", ""], ["c", "y"]]);
});

test("an empty line has one empty span; empty ranges are dropped", () => {
  assert.deepEqual(show("", [[{ from: 0, to: 0, cls: "x" }]]), [["", ""]]);
});

test("Japanese and surrogate pairs keep their units, never split a pair", () => {
  assert.deepEqual(show("霧🌊笛", [[{ from: 1, to: 3, cls: "x" }]]), [["霧", ""], ["🌊", "x"], ["笛", ""]]);
  // a boundary inside the pair is not used
  assert.ok(lineSpans("霧🌊笛", [[{ from: 1, to: 2, cls: "x" }]]).every((s) => s.from !== 2 && s.to !== 2));
});

test("invisible characters: half-width and full-width spaces and tabs", () => {
  assert.deepEqual(invisibleRanges("a b　c\td"), [
    { from: 1, to: 2, cls: "inv-sp" },
    { from: 3, to: 4, cls: "inv-zsp" },
    { from: 5, to: 6, cls: "inv-tab" },
  ]);
});

test("zero-width and control characters are marked whether or not invisibles are shown", () => {
  assert.deepEqual(specialRanges("a\u200bb\ufeffc\u0007"), [
    { from: 1, to: 2, cls: "ed-special" },
    { from: 3, to: 4, cls: "ed-special" },
    { from: 5, to: 6, cls: "ed-special" },
  ]);
  assert.deepEqual(specialRanges("普通の文　 \t"), []);
});
