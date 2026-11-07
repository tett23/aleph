import { test } from "node:test";
import assert from "node:assert/strict";
import { changeSet } from "./change.ts";
import { textOf } from "./text.ts";
import { changedLines, linesOfRanges, mapRanges } from "./update.ts";

const doc = textOf("one\ntwo\nthree");

const lines = (rs: { from: number; to?: number; insert: string }[]) => changedLines(doc, changeSet(rs, doc.length));

test("a change inside a line redraws that line only", () => {
  assert.deepEqual(lines([{ from: 5, to: 6, insert: "W" }]), { from: 2, removed: 1, added: 1 });
});

test("inserting a line break turns one line into two", () => {
  assert.deepEqual(lines([{ from: 5, insert: "\n" }]), { from: 2, removed: 1, added: 2 });
  assert.deepEqual(lines([{ from: 3, insert: "\nnew" }]), { from: 1, removed: 1, added: 2 });
});

test("deleting across lines turns them into one", () => {
  assert.deepEqual(lines([{ from: 2, to: 9, insert: "" }]), { from: 1, removed: 3, added: 1 });
  assert.deepEqual(lines([{ from: 3, to: 4, insert: "" }]), { from: 1, removed: 2, added: 1 });
});

test("appending at the end of the document changes the last line", () => {
  assert.deepEqual(lines([{ from: 13, insert: "!\nfour" }]), { from: 3, removed: 1, added: 2 });
});

test("several parts give one range from the first to the last", () => {
  assert.deepEqual(lines([{ from: 0, insert: "a" }, { from: 9, insert: "\n" }]), { from: 1, removed: 3, added: 4 });
});

test("an empty change redraws nothing", () => {
  assert.equal(lines([]), null);
});

test("ranges follow a change: shifted after it, cut where it removed text, dropped when emptied", () => {
  const c = changeSet([{ from: 2, insert: "XX" }, { from: 6, to: 8, insert: "" }], 12);
  const out = mapRanges([{ from: 0, to: 2, cls: "a" }, { from: 3, to: 5, cls: "b" }, { from: 6, to: 8, cls: "c" }, { from: 7, to: 11, cls: "d" }], c);
  assert.deepEqual(out, [
    { from: 0, to: 2, cls: "a" },
    { from: 5, to: 7, cls: "b" },
    { from: 8, to: 11, cls: "d" },
  ]);
});

test("a range with text inserted inside it grows", () => {
  const c = changeSet([{ from: 3, insert: "ab" }], 10);
  assert.deepEqual(mapRanges([{ from: 1, to: 5, cls: "x" }], c), [{ from: 1, to: 7, cls: "x" }]);
});

test("a zero-width range stays (a diagnostic at a point)", () => {
  const c = changeSet([{ from: 0, insert: "ab" }], 10);
  assert.deepEqual(mapRanges([{ from: 4, to: 4, cls: "x" }], c), [{ from: 6, to: 6, cls: "x" }]);
});

test("ranges are given to each line in the line's own offsets, cut at line ends", () => {
  const per = linesOfRanges(doc, [{ from: 1, to: 2, cls: "a" }, { from: 2, to: 6, cls: "b" }, { from: 13, to: 13, cls: "p" }]);
  assert.deepEqual(per.get(1), [{ from: 1, to: 2, cls: "a" }, { from: 2, to: 3, cls: "b" }]);
  assert.deepEqual(per.get(2), [{ from: 0, to: 2, cls: "b" }]);
  assert.deepEqual(per.get(3), [{ from: 5, to: 5, cls: "p" }]);
});
