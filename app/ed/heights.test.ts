import { test } from "node:test";
import assert from "node:assert/strict";
import { blockViewport, createHeights, estimateSize, renderRange, scrollTarget } from "./heights.ts";

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

const rect = (left: number, top: number, width: number, height: number) => ({ left, top, right: left + width, bottom: top + height, width, height });

test("the viewport along the block axis: down from the top in horizontal, left from the right edge in vertical", () => {
  // the lines start 300px above the pane's top: 300px of them are scrolled past
  assert.deepEqual(blockViewport(false, rect(0, 100, 800, 600), rect(50, -200, 700, 5000)), { start: 300, size: 600 });
  // vertical: the lines start 400px right of the pane's right edge
  assert.deepEqual(blockViewport(true, rect(100, 0, 900, 700), rect(-3000, 20, 4400, 600)), { start: 400, size: 900 });
  // an editor below the pane in a shared pane: a negative start
  assert.deepEqual(blockViewport(false, rect(0, 0, 800, 600), rect(0, 900, 800, 400)), { start: -900, size: 600 });
});

test("where to scroll to show a line: centred, or just enough to bring it in", () => {
  const vp = { start: 1000, size: 500 };
  assert.equal(scrollTarget(2000, 30, vp, true), 1800);
  assert.equal(scrollTarget(2000, 30, vp, false), 2000 + 30 - 500 + 24);
  assert.equal(scrollTarget(500, 30, vp, false), 500 - 24);
  // already in view: stays
  assert.equal(scrollTarget(1200, 30, vp, false), 1000);
});
