import { test } from "node:test";
import assert from "node:assert/strict";
import { createHighlighter, languageOf } from "./lang.ts";
import { textOf } from "./text.ts";

/** Each token of one line as [text, class]. */
const toks = (kind: string, src: string, lineNo = 1) => {
  const doc = textOf(src);
  const h = createHighlighter(languageOf(kind));
  const line = doc.line(lineNo).text;
  return h.tokens(doc, lineNo).map((t) => [line.slice(t.from, t.to), t.cls]);
};

test(".gm: commands, expressions, comments, headings, escapes, from gm.ts", () => {
  assert.deepEqual(toks("gm", "[ruby: 霧|む]は[= x]"), [["[ruby:", "t-cmd"], ["|", "t-cmd"], ["]", "t-cmd"], ["[= x]", "t-expr"]]);
  assert.deepEqual(toks("gm", "# 霧笛"), [["#", "t-mark"], [" 霧笛", "t-heading"]]);
  assert.deepEqual(toks("gm", "a%% c %%\\["), [["%% c %%", "t-comment"], ["\\[", "t-escape"]]);
});

test(".gm: a comment and a code block span lines", () => {
  assert.deepEqual(toks("gm", "本文%% 続く\nまだ %%後", 2), [["まだ %%", "t-comment"]]);
  assert.deepEqual(toks("gm", "```\n[ruby: x|y]\n```", 2), [["[ruby: x|y]", "t-code"]]);
});

test(".emet: keywords, types, strings, numbers, operators, comments over lines", () => {
  assert.deepEqual(toks("emet", 'pub fn f :: Int -> "a" 12 -- c'), [
    ["pub", "t-keyword"], ["fn", "t-keyword"], ["f", "t-var"], ["::", "t-operator"], ["Int", "t-type"], ["->", "t-operator"], ['"a"', "t-string"], ["12", "t-number"], ["-- c", "t-comment"],
  ]);
  assert.deepEqual(toks("emet", "{- a\nb -} x", 2), [["b -}", "t-comment"], ["x", "t-var"]]);
});

test(".md: headings, lists, quotes, code, emphasis, links, fences", () => {
  assert.deepEqual(toks("md", "# 題"), [["# 題", "t-heading"]]);
  assert.deepEqual(toks("md", "- **強** `c` [l](u)"), [["- ", "t-keyword"], ["**強**", "t-strong"], ["`c`", "t-code"], ["[l](u)", "t-link"]]);
  assert.deepEqual(toks("md", "> 引用"), [[">", "t-quote"]]);
  assert.deepEqual(toks("md", "```\n# not\n```", 2), [["# not", "t-code"]]);
});

test(".toml: tables, keys, strings, numbers, booleans, comments, multi-line strings", () => {
  assert.deepEqual(toml('[page.grid]'), [["[page.grid]", "t-heading"]]);
  assert.deepEqual(toml('size = "A6" # c'), [["size", "t-attr"], ["=", "t-operator"], ['"A6"', "t-string"], ["# c", "t-comment"]]);
  assert.deepEqual(toml("lines = 16\non = true", 2), [["on", "t-attr"], ["=", "t-operator"], ["true", "t-keyword"]]);
  assert.deepEqual(toml('a = """\nx\n"""', 2), [["x", "t-string"]]);
});
function toml(src: string, n = 1) {
  return toks("toml", src, n);
}

test("XML (svg): tags, attributes, strings, comments over lines", () => {
  assert.deepEqual(toks("svg", '<rect x="1"/>'), [["<rect", "t-tag"], ["x", "t-attr"], ["=", "t-operator"], ['"1"', "t-string"], ["/>", "t-tag"]]);
  assert.deepEqual(toks("svg", "<!-- a\nb --><g>", 2), [["b -->", "t-comment"], ["<g>", "t-tag"]]);
});

test("Mermaid: diagram keyword, arrows, labels, comments", () => {
  assert.deepEqual(toks("mmd", "graph TD"), [["graph", "t-keyword"]]);
  assert.deepEqual(toks("mmd", "A[灯台] --> B %% c"), [["[灯台]", "t-string"], ["-->", "t-operator"], ["%% c", "t-comment"]]);
});

test("unknown kinds have no tokens", () => {
  assert.deepEqual(toks("txt", "[ruby: x|y]"), []);
});

test("a change re-reads from the changed line until the line state is the same as before", () => {
  const h = createHighlighter(languageOf("gm"));
  const a = textOf("一\n二\n三\n四");
  h.tokens(a, 4);
  assert.equal(h.stats().read, 4);
  // a change in line 2 that does not change its end state: only line 2 is read again
  const b = textOf("一\n二二\n三\n四");
  h.changed(2);
  h.tokens(b, 4);
  assert.equal(h.stats().read, 5);
  // opening a comment in line 1 changes every later state
  const c = textOf("一%%\n二二\n三\n四");
  h.changed(1);
  h.tokens(c, 4);
  assert.equal(h.stats().read, 9);
  assert.deepEqual(h.tokens(c, 3).map((t) => t.cls), ["t-comment"]);
});

test("lines added or removed by a change: states after them shift with them", () => {
  const h = createHighlighter(languageOf("gm"));
  const a = textOf("一\n%%\n三\n四");
  h.tokens(a, 4);
  // two lines inserted after line 1: line 2 onward moves down, the comment stays on its line
  const b = textOf("一\n甲\n乙\n%%\n三\n四");
  h.changed(2, 0, 2);
  assert.deepEqual(h.tokens(b, 4).map((t) => t.cls), ["t-comment"]);
  assert.deepEqual(h.tokens(b, 2), []);
  // the comment line removed: nothing is a comment any more
  const c = textOf("一\n甲\n乙\n三\n四");
  h.changed(4, 1, 0);
  assert.deepEqual(h.tokens(c, 4), []);
  assert.deepEqual(h.tokens(c, 5), []);
});
