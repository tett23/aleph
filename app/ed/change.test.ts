import { test } from "node:test";
import assert from "node:assert/strict";
import { applyChanges, changeSet, composeChanges, invertChanges, mapPos } from "./change.ts";
import { textOf } from "./text.ts";

const doc = textOf("0123456789");

test("several replacements apply against the original text, in any order of giving", () => {
  const c = changeSet([{ from: 8, to: 9, insert: "X" }, { from: 1, to: 3, insert: "" }, { from: 5, insert: "--" }], doc.length);
  assert.equal(applyChanges(doc, c).toString(), "034--567X9");
});

test("overlapping replacements are refused", () => {
  assert.throws(() => changeSet([{ from: 1, to: 4, insert: "" }, { from: 3, to: 5, insert: "" }], doc.length));
  assert.throws(() => changeSet([{ from: 9, to: 12, insert: "" }], doc.length));
});

test("positions map through a change; an insertion at a position goes after it, or before with assoc -1", () => {
  const c = changeSet([{ from: 2, insert: "ab" }, { from: 5, to: 7, insert: "Z" }], doc.length);
  assert.equal(mapPos(c, 0), 0);
  assert.equal(mapPos(c, 2), 4);
  assert.equal(mapPos(c, 2, -1), 2);
  assert.equal(mapPos(c, 4), 6);
  assert.equal(mapPos(c, 6), 8); // inside the replaced range: after the replacement "01ab234Z|789"
  assert.equal(mapPos(c, 6, -1), 8);
  assert.equal(mapPos(c, 10), 11);
});

test("the inverse undoes a change", () => {
  const c = changeSet([{ from: 1, to: 3, insert: "あい" }, { from: 9, insert: "!" }], doc.length);
  const after = applyChanges(doc, c);
  assert.equal(applyChanges(after, invertChanges(c, doc)).toString(), doc.toString());
});

test("two changes in a row compose into one", () => {
  const a = changeSet([{ from: 2, insert: "xy" }], doc.length);
  const mid = applyChanges(doc, a);
  const b = changeSet([{ from: 0, to: 1, insert: "" }, { from: 3, to: 5, insert: "Q" }], mid.length);
  const end = applyChanges(mid, b);
  const ab = composeChanges(a, b, doc);
  assert.equal(applyChanges(doc, ab).toString(), end.toString());
  assert.equal(applyChanges(end, invertChanges(ab, doc)).toString(), doc.toString());
});
