import { test } from "node:test";
import assert from "node:assert/strict";
import { applyChanges, classOf, completionStart, decodeSemanticTokens, editsToChanges, offsetOf, tokenRanges, uriOf, type TextEdit } from "./protocol.ts";

test("a URI encodes each part of the path", () => {
  assert.equal(uriOf("/Users/a/灯台守 の冬/chapters/01.gm"), "file:///Users/a/%E7%81%AF%E5%8F%B0%E5%AE%88%20%E3%81%AE%E5%86%AC/chapters/01.gm");
  assert.equal(uriOf("/a/b#c?.gm"), "file:///a/b%23c%3F.gm");
});

test("a position is an offset in UTF-16 units; past the end is clamped", () => {
  const text = "霧笛🌊\n二行目\n";
  assert.equal(offsetOf(text, { line: 0, character: 2 }), 2);
  assert.equal(offsetOf(text, { line: 0, character: 4 }), 4); // after the surrogate pair
  assert.equal(offsetOf(text, { line: 1, character: 1 }), 6);
  assert.equal(offsetOf(text, { line: 1, character: 99 }), 8); // end of the line
  assert.equal(offsetOf(text, { line: 9, character: 0 }), text.length);
});

const edit = (l1: number, c1: number, l2: number, c2: number, newText: string): TextEdit => ({
  range: { start: { line: l1, character: c1 }, end: { line: l2, character: c2 } },
  newText,
});

test("several edits apply against the original text, in any order", () => {
  const text = "[ruby:霧笛|むてき]は\n[ruby:灯|ひ]\n";
  const edits = [edit(1, 6, 1, 6, " "), edit(0, 6, 0, 6, " ")];
  assert.equal(applyChanges(text, editsToChanges(text, edits)), "[ruby: 霧笛|むてき]は\n[ruby: 灯|ひ]\n");
});

test("an edit past the end of the document is clamped to it", () => {
  const text = "a\nb";
  assert.equal(applyChanges(text, editsToChanges(text, [edit(1, 0, 5, 0, "B\n")])), "a\nB\n");
});

test("replacing the whole text", () => {
  const text = "x  y\n\n\n";
  assert.equal(applyChanges(text, editsToChanges(text, [edit(0, 0, 3, 0, "x y\n")])), "x y\n");
});

test("no edits, no changes", () => {
  assert.deepEqual(editsToChanges("abc", []), []);
  assert.deepEqual(editsToChanges("abc", [edit(0, 0, 0, 3, "abc")]), []);
});

const legend = {
  tokenTypes: ["namespace", "type", "class", "enum", "interface", "struct", "typeParameter", "parameter", "variable", "property", "enumMember", "event", "function", "method", "macro", "keyword", "modifier", "comment", "string", "number", "regexp", "operator", "decorator"],
  tokenModifiers: ["declaration", "definition", "readonly"],
};

test("semantic tokens: relative positions become absolute, across lines", () => {
  // what golem lsp returned for "# 霧笛\n\n[ruby: 霧笛|むてき]は[= book.liters(12)]…"
  const data = [0, 0, 1, 15, 0, 0, 2, 2, 0, 0, 2, 1, 4, 12, 0, 0, 8, 1, 21, 0, 0, 6, 2, 15, 3];
  assert.deepEqual(decodeSemanticTokens(data, legend), [
    { line: 0, start: 0, length: 1, type: "keyword", modifiers: [] },
    { line: 0, start: 2, length: 2, type: "namespace", modifiers: [] },
    { line: 2, start: 1, length: 4, type: "function", modifiers: [] },
    { line: 2, start: 9, length: 1, type: "operator", modifiers: [] },
    { line: 2, start: 15, length: 2, type: "keyword", modifiers: ["declaration", "definition"] },
  ]);
});

test("semantic tokens: an unknown type index is dropped, a short tail is ignored", () => {
  assert.deepEqual(decodeSemanticTokens([0, 0, 1, 99, 0, 0, 1, 1, 17, 0, 0, 1], legend), [{ line: 0, start: 1, length: 1, type: "comment", modifiers: [] }]);
});

test("token ranges are offsets in the editor's document, Japanese lines included", () => {
  const text = "# 霧笛\n\n[ruby: 霧笛|むてき]は";
  const r = tokenRanges(text, decodeSemanticTokens([0, 0, 1, 15, 0, 0, 2, 2, 0, 0, 2, 1, 4, 12, 0, 0, 8, 1, 21, 0], legend));
  assert.deepEqual(
    r.map(({ from, to, cls }) => [text.slice(from, to), cls]),
    [["#", "mark"], ["霧笛", "heading"], ["ruby", "cmd"], ["|", "cmd"]],
  );
});

test("token types map to the classes of Golem's table", () => {
  assert.equal(classOf("decorator", "@need-lines"), "cmd");
  assert.equal(classOf("macro", "\\["), "escape");
  assert.equal(classOf("string", "赤"), "expr");
  assert.equal(classOf("number", "12"), "expr");
  assert.equal(classOf("comment", "%% x %%"), "comment");
  assert.equal(classOf("keyword", "##"), "mark");
  assert.equal(classOf("keyword", "[="), "cmd");
  assert.equal(classOf("regexp", "x"), null);
});

test("completion starts at the word before the caret, after [ or a space unless asked for", () => {
  assert.equal(completionStart("[fig", false), 1);
  assert.equal(completionStart("text [ruby", false), 6);
  assert.equal(completionStart("a fig", false), 2);
  assert.equal(completionStart("text", false), null);
  assert.equal(completionStart("text", true), 0);
  assert.equal(completionStart("[book.st", false), 1);
  assert.equal(completionStart("", true), 0);
});
