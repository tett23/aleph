import { test } from "node:test";
import assert from "node:assert/strict";
import { createHeights, estimateSize, renderRange } from "./heights.ts";

test("an unmeasured line is estimated from its characters and the characters per line", () => {
  assert.equal(estimateSize(0, 38, 28), 28);
  assert.equal(estimateSize(38, 38, 28), 28);
  assert.equal(estimateSize(39, 38, 28), 56);
});

test("offsets, totals and the line at an offset", () => {
  const h = createHeights([10, 20, 30, 40]);
  assert.equal(h.total(), 100);
  assert.equal(h.offsetOf(0), 0);
  assert.equal(h.offsetOf(2), 30);
  assert.equal(h.lineAt(0), 0);
  assert.equal(h.lineAt(29), 1);
  assert.equal(h.lineAt(30), 2);
  assert.equal(h.lineAt(999), 3);
});

test("measuring a line and splicing lines keep the sums right", () => {
  const h = createHeights([10, 10, 10, 10]);
  h.set(1, 25);
  assert.equal(h.offsetOf(2), 35);
  h.splice(1, 2, [5, 5, 5]); // lines 1-2 replaced by three lines
  assert.equal(h.count(), 5);
  assert.equal(h.total(), 10 + 15 + 10);
  assert.equal(h.offsetOf(4), 25);
});

test("a large map stays fast enough: 200k lines, many updates", () => {
  const h = createHeights(new Array(200_000).fill(20));
  const t = Date.now();
  for (let i = 0; i < 20_000; i++) h.set((i * 7919) % 200_000, 20 + (i % 5));
  for (let i = 0; i < 20_000; i++) h.lineAt((i * 104729) % h.total());
  assert.ok(Date.now() - t < 500);
});

test("the lines to draw: the view and a margin, plus lines that must be drawn", () => {
  const h = createHeights(new Array(100).fill(10));
  assert.deepEqual(renderRange(h, 200, 100, 50, []), [{ from: 15, to: 34 }]);
  // the selection's other end and the composing line far away are drawn too
  assert.deepEqual(renderRange(h, 200, 100, 50, [3, 90]), [{ from: 3, to: 3 }, { from: 15, to: 34 }, { from: 90, to: 90 }]);
  // a must-draw line inside the range adds nothing
  assert.deepEqual(renderRange(h, 0, 100, 0, [5]), [{ from: 0, to: 9 }]);
});
