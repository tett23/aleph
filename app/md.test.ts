import { test } from "node:test";
import assert from "node:assert/strict";
import { markdownHtml, parseInline, parseMarkdown } from "./md.ts";

test("inline: emphasis, strong, code, nesting", () => {
  assert.deepEqual(parseInline("a **b *c* d** e"), [
    { t: "text", v: "a " },
    { t: "strong", c: [{ t: "text", v: "b " }, { t: "em", c: [{ t: "text", v: "c" }] }, { t: "text", v: " d" }] },
    { t: "text", v: " e" },
  ]);
  assert.deepEqual(parseInline("__x__ _y_"), [{ t: "strong", c: [{ t: "text", v: "x" }] }, { t: "text", v: " " }, { t: "em", c: [{ t: "text", v: "y" }] }]);
  assert.deepEqual(parseInline("**`a*b`**"), [{ t: "strong", c: [{ t: "code", v: "a*b" }] }]);
});

test("inline: an unclosed or spaced delimiter is text; snake_case is text", () => {
  assert.deepEqual(parseInline("2 * 3 * 4"), [{ t: "text", v: "2 * 3 * 4" }]);
  assert.deepEqual(parseInline("**open"), [{ t: "text", v: "**open" }]);
  assert.deepEqual(parseInline("snake_case_name"), [{ t: "text", v: "snake_case_name" }]);
});

test("inline: links, images, escapes, HTML stays text", () => {
  assert.deepEqual(parseInline("[灯台 **守**](https://x.test/a)"), [
    { t: "link", href: "https://x.test/a", c: [{ t: "text", v: "灯台 " }, { t: "strong", c: [{ t: "text", v: "守" }] }] },
  ]);
  assert.deepEqual(parseInline("![図](images/a.png)"), [{ t: "image", src: "images/a.png", alt: "図" }]);
  assert.deepEqual(parseInline("\\*not\\* <b>"), [{ t: "text", v: "*not* <b>" }]);
});

test("blocks: headings (closing # removed), paragraphs, hard breaks", () => {
  assert.deepEqual(parseMarkdown("## 見出し ##\n\n一行目  \n二行目\n"), [
    { t: "heading", level: 2, c: [{ t: "text", v: "見出し" }] },
    { t: "para", lines: [{ c: [{ t: "text", v: "一行目" }], hard: true }, { c: [{ t: "text", v: "二行目" }], hard: false }] },
  ]);
});

test("blocks: nested and ordered lists", () => {
  const [l] = parseMarkdown("- a\n  - b\n    - c\n- d\n1. e\n2) f\n");
  assert.deepEqual(
    l.t === "list" && l.items.map((i) => [i.depth, i.ordered, i.c[0]]),
    [[0, false, { t: "text", v: "a" }], [1, false, { t: "text", v: "b" }], [2, false, { t: "text", v: "c" }], [0, false, { t: "text", v: "d" }], [0, true, { t: "text", v: "e" }], [0, true, { t: "text", v: "f" }]],
  );
});

test("blocks: code fences keep their text, tables their rows, quotes and rules", () => {
  assert.deepEqual(parseMarkdown("```gm\n[ruby: a|b] **x**\n```\n"), [{ t: "code", lang: "gm", text: "[ruby: a|b] **x**" }]);
  assert.deepEqual(parseMarkdown("| a | b |\n|---|:-:|\n| 1 | 2 |\n"), [{ t: "table", rows: ["| a | b |", "|---|:-:|", "| 1 | 2 |"] }]);
  assert.deepEqual(parseMarkdown("> 引用\n> 続き\n\n---\n"), [
    { t: "quote", lines: [{ c: [{ t: "text", v: "引用" }], hard: false }, { c: [{ t: "text", v: "続き" }], hard: false }] },
    { t: "hr" },
  ]);
});

test("blocks: an image alone on a line", () => {
  assert.deepEqual(parseMarkdown("![灯台](images/l.png)\n\n文 ![x](y.png)\n"), [
    { t: "image", alt: "灯台", src: "images/l.png" },
    { t: "para", lines: [{ c: [{ t: "text", v: "文 " }, { t: "image", src: "y.png", alt: "x" }], hard: false }] },
  ]);
});

test("HTML for the preview: escaped, lists nested, scripts in URLs dropped", () => {
  assert.equal(markdownHtml("# a <b>\n"), "<h1>a &lt;b&gt;</h1>");
  assert.equal(markdownHtml("- a\n  - b\n- c\n"), "<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>");
  assert.equal(markdownHtml("[x](javascript:alert(1))"), '<p><a href="#">x</a>)</p>');
  assert.equal(markdownHtml("| a | b |\n|---|---|\n| 1 | `\\|` |\n"), "<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td><code>|</code></td></tr></tbody></table>");
});
