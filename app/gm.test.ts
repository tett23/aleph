import { test } from "node:test";
import assert from "node:assert/strict";
import { estimatePageBreaks, gmBlocks, inlinePlain, startState, tokenizeLine, type LineState } from "./gm.ts";

/** Each character's class, one letter per character: c command, e expression, k comment, H heading, h mark, x escape, f fence, o code, . prose. */
const classes = (line: string, st: LineState = startState()) => {
  const { tokens } = tokenizeLine(line, st);
  const letter = { command: "c", expression: "e", comment: "k", heading: "H", headingMark: "h", escape: "x", fence: "f", code: "o" } as const;
  return [...line].map((_, i) => {
    const t = tokens.find((t) => t.from <= i && i < t.to);
    return t ? letter[t.type] : ".";
  }).join("");
};

test("an inline command: head and arguments are command, the prose slot is prose", () => {
  assert.equal(classes("[ruby: 霧笛|むてき]は"), "cccccc...c...c.");
});

test("an expression is expression throughout, nested brackets included", () => {
  assert.equal(classes("油は[= f([1, 2])]L"), ".." + "e".repeat(13) + ".");
});

test("a command with arguments and a quoted string", () => {
  assert.equal(classes("[book.stamp 赤]消"), "c".repeat(14) + ".");
  assert.equal(classes('[a x="]" y]z'), "c".repeat(11) + ".");
});

test("nested commands in a prose slot", () => {
  assert.equal(classes("[strong: [ruby: 漢|かん]字]"), "cccccccc.cccccc..c..c.c");
});

test("headings: the mark, then heading text, with commands inside", () => {
  assert.equal(classes("# 霧笛"), "h.HH".replace(".", "H"));
  assert.equal(classes("## [= x]章"), "hhHeeeeeH");
});

test("a block command line: the whole line is command", () => {
  assert.equal(classes("@import functions/book.emet as book"), "c".repeat(35));
  assert.equal(classes("  @need-lines 4"), "c".repeat(15));
});

test("comments, also across lines", () => {
  assert.equal(classes("本文%% メモ %%本文"), "..kkkkkkkk..");
  const first = tokenizeLine("本文%% 続く", startState());
  assert.equal(first.state.comment, true);
  assert.equal(classes("まだ %%後", first.state), "kkkkk.");
});

test("escapes", () => {
  assert.equal(classes("a\\[b"), ".xx.");
});

test("a code block is code until the fence closes", () => {
  const open = tokenizeLine("```haskell", startState());
  assert.equal(classes("```haskell"), "ffffffffff");
  assert.equal(classes("[ruby: x|y] %% z", open.state), "oooooooooooooooo");
});

test("a blank line ends open brackets and comments", () => {
  const a = tokenizeLine("[ruby: 続", startState());
  assert.equal(a.state.stack.length, 1);
  const b = tokenizeLine("", a.state);
  assert.deepEqual(b.state.stack, []);
});

test("plain text keeps the first prose slot and drops commands, expressions, comments", () => {
  assert.equal(inlinePlain("[ruby: 霧笛|むてき]は三度"), "霧笛は三度");
  assert.equal(inlinePlain("残りは[= book.liters(12)]L%% メモ %%。"), "残りはL。");
  assert.equal(inlinePlain("[book.stamp 赤]消印"), "消印");
  assert.equal(inlinePlain("[ruby: 東/京|とう/きょう]"), "東京");
  assert.equal(inlinePlain("a\\[b\\]"), "a[b]");
});

test("blocks: headings, paragraphs joined across lines, breaks; commands and code skipped", () => {
  const src = "@import a.emet as a\n\n# 霧笛\n\n一行目\n二行目\n\n@page-break\n\n```\n# not\n```\n- 項目\n";
  const b = gmBlocks(src);
  assert.deepEqual(b, [
    { kind: "h", level: 1, text: "霧笛", line: 2 },
    { kind: "p", text: "一行目二行目", line: 4 },
    { kind: "break", line: 7 },
    { kind: "p", text: "項目", line: 12 },
  ]);
});

test("blocks in the line style: each line is a paragraph", () => {
  assert.deepEqual(gmBlocks("一\n二\n", "line"), [
    { kind: "p", text: "一", line: 0 },
    { kind: "p", text: "二", line: 1 },
  ]);
});

test("page breaks: @page-break starts a page after it", () => {
  const src = "# 一\n\n本文\n\n@page-break\n\n# 二\n";
  assert.deepEqual(estimatePageBreaks(src, { chars: 10, lines: 16, vertical: false }), [{ line: 5, page: 2 }]);
});

test("page breaks: a long paragraph breaks inside it", () => {
  // 5 lines of 10 characters per source line, 8 lines a page: the break falls in the second source line
  const line = "あ".repeat(50);
  const src = `${line}\n${line}\n`;
  assert.deepEqual(estimatePageBreaks(src, { chars: 10, lines: 8, vertical: false }), [{ line: 1, page: 2 }]);
});

test("page breaks: a heading that does not fit moves to the next page", () => {
  const src = `${"あ".repeat(70)}\n\n# 見出し\n`;
  assert.deepEqual(estimatePageBreaks(src, { chars: 10, lines: 8, vertical: false }), [{ line: 2, page: 2 }]);
});

test("page breaks follow the paragraph separator: the line style makes each line a paragraph", () => {
  // two source lines of 15 characters, 10 characters a line, 3 lines a page:
  // blank-line style: one paragraph of 30 characters, 3 lines, no break;
  // line style: two paragraphs of 2 lines each, the second breaks onto page 2
  const src = `${"あ".repeat(15)}\n${"い".repeat(15)}\n`;
  const grid = { chars: 10, lines: 3, vertical: false };
  assert.deepEqual(estimatePageBreaks(src, grid, "blank-line"), []);
  assert.deepEqual(estimatePageBreaks(src, grid, "line"), [{ line: 1, page: 2 }]);
});
