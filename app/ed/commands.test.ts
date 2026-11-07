import { test } from "node:test";
import assert from "node:assert/strict";
import { filterItems, indent } from "./commands.ts";
import { textOf } from "./text.ts";

const doc = textOf("a\n  b\nc");

test("Tab indents every line the selection touches by two spaces", () => {
  assert.deepEqual(indent(doc, { from: 0, to: 0 }, 1), [{ from: 0, to: 0, insert: "  " }]);
  assert.deepEqual(indent(doc, { from: 1, to: 7 }, 1), [
    { from: 0, to: 0, insert: "  " },
    { from: 2, to: 2, insert: "  " },
    { from: 6, to: 6, insert: "  " },
  ]);
});

test("a selection ending at the start of a line leaves that line alone", () => {
  assert.deepEqual(indent(doc, { from: 0, to: 2 }, 1), [{ from: 0, to: 0, insert: "  " }]);
});

test("Shift-Tab takes up to two spaces (or a tab) off each line", () => {
  assert.deepEqual(indent(doc, { from: 0, to: 7 }, -1), [{ from: 2, to: 4, insert: "" }]);
  assert.deepEqual(indent(textOf(" x\n\ty"), { from: 0, to: 5 }, -1), [
    { from: 0, to: 1, insert: "" },
    { from: 3, to: 4, insert: "" },
  ]);
});

test("completion items are those starting with the typed word, case ignored, in the server's order", () => {
  const items = [{ label: "figure" }, { label: "Footnote" }, { label: "ruby" }];
  assert.deepEqual(filterItems(items, "f").map((i) => i.label), ["figure", "Footnote"]);
  assert.deepEqual(filterItems(items, "").map((i) => i.label), ["figure", "Footnote", "ruby"]);
  assert.deepEqual(filterItems(items, "x"), []);
});
