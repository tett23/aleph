import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore, initialState, transact } from "./core.ts";

const clock = () => {
  let t = 1000;
  return { now: () => t, tick: (ms: number) => (t += ms) };
};

test("an edit changes the text and the selection, and tells what lines changed", () => {
  const c = createCore("ab\ncd");
  const seen: unknown[] = [];
  c.listen((tx) => seen.push(tx.lines));
  c.apply([{ from: 1, insert: "X\n" }], "input.type", { anchor: 3, head: 3 });
  assert.equal(c.doc().toString(), "aX\nb\ncd");
  assert.deepEqual(c.sel(), { anchor: 3, head: 3 });
  assert.deepEqual(seen, [{ from: 1, removed: 1, added: 2 }]);
});

test("without a selection given, the selection maps through the change", () => {
  const c = createCore("abcdef");
  c.select({ anchor: 4, head: 4 });
  c.apply([{ from: 0, insert: "zz" }], "format");
  assert.deepEqual(c.sel(), { anchor: 6, head: 6 });
});

test("undo puts back the text and the selection before; redo the one after", () => {
  const k = clock();
  const c = createCore("hello", k.now);
  c.select({ anchor: 5, head: 5 });
  c.apply([{ from: 5, insert: "!" }], "input.type", { anchor: 6, head: 6 });
  assert.equal(c.undo(), true);
  assert.equal(c.doc().toString(), "hello");
  assert.deepEqual(c.sel(), { anchor: 5, head: 5 });
  assert.equal(c.redo(), true);
  assert.equal(c.doc().toString(), "hello!");
  assert.deepEqual(c.sel(), { anchor: 6, head: 6 });
  assert.equal(c.redo(), false);
});

test("typing within 500 ms is one step; formatting is a step of its own", () => {
  const k = clock();
  const c = createCore("", k.now);
  c.apply([{ from: 0, insert: "a" }], "input.type", { anchor: 1, head: 1 });
  k.tick(100);
  c.apply([{ from: 1, insert: "b" }], "input.type", { anchor: 2, head: 2 });
  k.tick(100);
  c.apply([{ from: 0, to: 2, insert: "AB" }], "format");
  c.undo();
  assert.equal(c.doc().toString(), "ab");
  c.undo();
  assert.equal(c.doc().toString(), "");
});

test("moving the caret away seals the step, so later typing undoes on its own", () => {
  const k = clock();
  const c = createCore("xy", k.now);
  c.apply([{ from: 0, insert: "a" }], "input.type", { anchor: 1, head: 1 });
  c.select({ anchor: 3, head: 3 }, true);
  c.apply([{ from: 3, insert: "b" }], "input.type", { anchor: 4, head: 4 });
  c.undo();
  assert.equal(c.doc().toString(), "axy");
});

test("replacing the whole text (a file read again) is undoable too", () => {
  const c = createCore("old");
  c.setText("new text");
  assert.equal(c.doc().toString(), "new text");
  c.undo();
  assert.equal(c.doc().toString(), "old");
});

test("layers (semantic tokens, diagnostics) follow edits until replaced", () => {
  const c = createCore("abc def");
  c.setLayer("diag", [{ from: 4, to: 7, cls: "diag-error" }]);
  c.apply([{ from: 0, insert: "__" }], "input.type");
  assert.deepEqual(c.layer("diag"), [{ from: 6, to: 9, cls: "diag-error" }]);
  c.setLayer("diag", []);
  assert.deepEqual(c.layer("diag"), []);
});

test("a selection past the end is clamped", () => {
  const c = createCore("abc");
  c.select({ anchor: 10, head: -2 });
  assert.deepEqual(c.sel(), { anchor: 3, head: 0 });
});

test("the selected text and the range, in order", () => {
  const c = createCore("abcdef");
  c.select({ anchor: 4, head: 1 });
  assert.deepEqual(c.range(), { from: 1, to: 4 });
  assert.equal(c.selectedText(), "bcd");
});

test("an edit that changes nothing is not recorded", () => {
  const c = createCore("abc");
  c.apply([], "input.type");
  assert.equal(c.undo(), false);
});

test("a transaction makes a new state and leaves the old one as it was", () => {
  const s0 = initialState("abc");
  const { state: s1, tx } = transact(s0, [{ from: 3, insert: "d" }], "input.type");
  assert.equal(s0.doc.toString(), "abc");
  assert.deepEqual(s0.sel, { anchor: 0, head: 0 });
  assert.equal(s1.doc.toString(), "abcd");
  assert.deepEqual(tx.lines, { from: 1, removed: 1, added: 1 });
  const s2 = { ...s1, layers: new Map([["diag", [{ from: 1, to: 2, cls: "x" }]]]) };
  const { state: s3 } = transact(s2, [{ from: 0, insert: "__" }], "format", { anchor: 0, head: 0 });
  assert.deepEqual(s2.layers.get("diag"), [{ from: 1, to: 2, cls: "x" }]);
  assert.deepEqual(s3.layers.get("diag"), [{ from: 3, to: 4, cls: "x" }]);
  assert.deepEqual(s3.sel, { anchor: 0, head: 0 });
});
