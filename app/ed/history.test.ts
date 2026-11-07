import { test } from "node:test";
import assert from "node:assert/strict";
import { changeSet } from "./change.ts";
import { createHistory, type Edit } from "./history.ts";
import { textOf, type Text } from "./text.ts";

const typed = (doc: Text, pos: number, s: string, time: number, kind = "input.type"): Edit => ({
  changes: changeSet([{ from: pos, insert: s }], doc.length),
  before: doc,
  time,
  kind,
});

test("typing within 500 ms is one step; a pause starts another", () => {
  let doc = textOf("");
  const h = createHistory();
  for (const [i, ch] of [..."abc"].entries()) {
    const e = typed(doc, i, ch, i * 100);
    h.record(e);
    doc = doc.replace(i, i, ch);
  }
  const e = typed(doc, 3, "d", 2000);
  h.record(e);
  doc = doc.replace(3, 3, "d");
  const u1 = h.undo(doc)!;
  doc = u1.doc;
  assert.equal(doc.toString(), "abc");
  doc = h.undo(doc)!.doc;
  assert.equal(doc.toString(), "");
  assert.equal(h.undo(doc), null);
});

test("redo after undo; a new edit clears redo", () => {
  let doc = textOf("x");
  const h = createHistory();
  h.record(typed(doc, 1, "y", 0));
  doc = doc.replace(1, 1, "y");
  doc = h.undo(doc)!.doc;
  doc = h.redo(doc)!.doc;
  assert.equal(doc.toString(), "xy");
  doc = h.undo(doc)!.doc;
  h.record(typed(doc, 0, "z", 10));
  doc = doc.replace(0, 0, "z");
  assert.equal(h.redo(doc), null);
});

test("a formatting or a drop is its own step even right after typing", () => {
  let doc = textOf("");
  const h = createHistory();
  h.record(typed(doc, 0, "a", 0));
  doc = doc.replace(0, 0, "a");
  h.record(typed(doc, 1, "@figure", 50, "format"));
  doc = doc.replace(1, 1, "@figure");
  doc = h.undo(doc)!.doc;
  assert.equal(doc.toString(), "a");
});

test("undo gives back where the caret was", () => {
  let doc = textOf("abc");
  const h = createHistory();
  h.record({ ...typed(doc, 3, "!", 0), selBefore: { anchor: 3, head: 3 } });
  doc = doc.replace(3, 3, "!");
  const u = h.undo(doc)!;
  assert.deepEqual(u.sel, { anchor: 3, head: 3 });
});
