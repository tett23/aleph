import { test } from "node:test";
import assert from "node:assert/strict";
import { domToOffset, lineText, nearestLine, offsetToDom, regionText, type Walk } from "./dompos.ts";

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

test("a position between the editor's children goes to the nearest drawn line", () => {
  // children: gap, line, line, gap, page break, line, gap
  const lines = [false, true, true, false, false, true, false];
  assert.deepEqual(nearestLine(lines, 1), { index: 1, end: false }); // just before a line: its start
  assert.deepEqual(nearestLine(lines, 3), { index: 2, end: true }); // just after a line: its end
  assert.deepEqual(nearestLine(lines, 4), { index: 2, end: true }); // past a gap: the line before, at its end
  assert.deepEqual(nearestLine(lines, 7), { index: 5, end: true });
  assert.deepEqual(nearestLine(lines, 0), { index: 1, end: false }); // before everything: the first line
  assert.equal(nearestLine([false, false], 1), null);
});

// WebKit can take an empty line's element away while composing and leave the committed text (and the
// <br>) straight in the editor's content, between the lines around it (seen with SKK)
test("the text between two lines: blocks are lines, loose text runs to a <br> are lines too", () => {
  type M = N & { block?: boolean; br?: boolean };
  const isBlock = (n: N) => !!(n as M).block;
  const isBreak = (n: N) => !!(n as M).br;
  const br: M = {};
  (br as M).br = true;
  const blockLine = (t: string): N => ({ block: true, kids: [gutter, { text: t }] }) as M;
  // the empty line's element gone, its text left loose with the <br>
  assert.equal(regionText(walk, [{ text: "漢字" }, br], isBlock, isBreak), "漢字");
  // loose text in spans, and with no <br> after it
  assert.equal(regionText(walk, [{ kids: [{ text: "漢" }] }, { text: "字" }], isBlock, isBreak), "漢字");
  // nothing left: an empty line
  assert.equal(regionText(walk, [], isBlock, isBreak), "");
  assert.equal(regionText(walk, [br], isBlock, isBreak), "");
  // line elements and loose text mixed, in order
  assert.equal(regionText(walk, [blockLine("霧笛"), { text: "漢字" }, br, blockLine("鳴る")], isBlock, isBreak), "霧笛\n漢字\n鳴る");
  // two loose runs split by a <br>
  assert.equal(regionText(walk, [{ text: "a" }, br, { text: "b" }, br], isBlock, isBreak), "a\nb");
  // skipped elements (gaps, page breaks) are left out
  assert.equal(regionText(walk, [{ skip: true, kids: [{ text: "改ページ" }] }, { text: "漢字" }, br], isBlock, isBreak), "漢字");
});
