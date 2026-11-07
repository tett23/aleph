import { test } from "node:test";
import assert from "node:assert/strict";
import { domToOffset, lineText, offsetToDom, type Walk } from "./dompos.ts";

// a fake DOM: elements with children, text nodes, and skipped elements (gutters, widgets)
type N = { text?: string; skip?: boolean; kids?: N[] };
const walk: Walk<N> = {
  isText: (n) => n.text !== undefined,
  text: (n) => n.text ?? "",
  children: (n) => n.kids ?? [],
  skip: (n) => !!n.skip,
};

const gutter: N = { skip: true, kids: [{ text: "12" }] };
const a: N = { text: "霧笛" };
const b: N = { text: "は" };
const line: N = { kids: [gutter, { kids: [a] }, { kids: [b] }, { skip: true, kids: [{ text: "↵" }] }] };

test("a document offset in the line finds its text node, skipping gutters and widgets", () => {
  assert.deepEqual(offsetToDom(walk, line, 0), { node: a, offset: 0 });
  assert.deepEqual(offsetToDom(walk, line, 1), { node: a, offset: 1 });
  assert.deepEqual(offsetToDom(walk, line, 2), { node: a, offset: 2 });
  assert.deepEqual(offsetToDom(walk, line, 3), { node: b, offset: 1 });
});

test("a DOM position gives the offset in the line", () => {
  assert.equal(domToOffset(walk, line, a, 1), 1);
  assert.equal(domToOffset(walk, line, b, 1), 3);
  // an element position: the offset before its child at that index
  assert.equal(domToOffset(walk, line, line, 2), 2);
  assert.equal(domToOffset(walk, line, line, 4), 3);
  // inside a skipped element: the start of what follows it
  assert.equal(domToOffset(walk, line, gutter.kids![0], 1), 0);
});

test("an empty line: offset 0 is the line itself", () => {
  const empty: N = { kids: [gutter, { kids: [{ text: "" }] }] };
  assert.equal(offsetToDom(walk, empty, 0).offset, 0);
  assert.equal(domToOffset(walk, empty, empty, 0), 0);
});

test("the text of a line leaves out gutters and widgets; a block the browser put inside is a line break", () => {
  assert.equal(lineText(walk, line, () => false), "霧笛は");
  const split: N = { kids: [gutter, { text: "霧" }, { block: true, kids: [{ text: "笛" }] } as N] };
  assert.equal(lineText(walk, split, (n) => !!(n as N & { block?: boolean }).block), "霧\n笛");
  assert.equal(lineText(walk, { kids: [gutter] }, () => false), "");
});
