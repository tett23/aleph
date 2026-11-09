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
    { t: "para", c: [{ t: "text", v: "一行目" }, { t: "hardbreak" }, { t: "text", v: "二行目" }] },
  ]);
});

test("blocks: nested and ordered lists; a new marker or delimiter starts a new list (CommonMark, docs/adr/0061)", () => {
  const p = (v: string) => ({ t: "para", c: [{ t: "text", v }] });
  assert.deepEqual(parseMarkdown("- a\n  - b\n    - c\n- d\n1. e\n2) f\n"), [
    {
      t: "list",
      ordered: false,
      start: 1,
      tight: true,
      items: [{ c: [p("a"), { t: "list", ordered: false, start: 1, tight: true, items: [{ c: [p("b"), { t: "list", ordered: false, start: 1, tight: true, items: [{ c: [p("c")] }] }] }] }] }, { c: [p("d")] }],
    },
    { t: "list", ordered: true, start: 1, tight: true, items: [{ c: [p("e")] }] },
    { t: "list", ordered: true, start: 2, tight: true, items: [{ c: [p("f")] }] },
  ]);
});

test("blocks: code fences keep their text, tables their rows, quotes and rules", () => {
  assert.deepEqual(parseMarkdown("```gm\n[ruby: a|b] **x**\n```\n"), [{ t: "code", lang: "gm", info: "gm", text: "[ruby: a|b] **x**" }]);
  const tx = (v: string) => [{ t: "text", v }];
  assert.deepEqual(parseMarkdown("| a | b |\n|---|:-:|\n| 1 | 2 |\n"), [{ t: "table", align: [null, "center"], head: [tx("a"), tx("b")], rows: [[tx("1"), tx("2")]] }]);
  assert.deepEqual(parseMarkdown("> 引用\n> 続き\n\n---\n"), [
    { t: "quote", c: [{ t: "para", c: [{ t: "text", v: "引用" }, { t: "softbreak", cjk: true }, { t: "text", v: "続き" }] }] },
    { t: "hr" },
  ]);
});

test("blocks: an image alone on a line", () => {
  assert.deepEqual(parseMarkdown("![灯台](images/l.png)\n\n文 ![x](y.png)\n"), [
    { t: "image", alt: "灯台", src: "images/l.png" },
    { t: "para", c: [{ t: "text", v: "文 " }, { t: "image", src: "y.png", alt: "x" }] },
  ]);
});

test("HTML for the preview: escaped, lists nested, scripts in URLs dropped", () => {
  assert.equal(markdownHtml("# a <b>\n"), "<h1>a &lt;b&gt;</h1>");
  assert.equal(markdownHtml("- a\n  - b\n- c\n"), "<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>");
  // the destination holds balanced parentheses (CommonMark, docs/adr/0061)
  assert.equal(markdownHtml("[x](javascript:alert(1))"), '<p><a href="#">x</a></p>');
  assert.equal(markdownHtml("| a | b |\n|---|---|\n| 1 | `\\|` |\n"), "<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td><code>|</code></td></tr></tbody></table>");
});

test("wikilinks are read inline and drawn as links to their target (docs/adr/0027)", () => {
  assert.deepEqual(parseInline("見て[[人物#家族|父]]と[[場所]]"), [
    { t: "text", v: "見て" },
    { t: "wikilink", target: "人物", heading: "家族", text: "父" },
    { t: "text", v: "と" },
    { t: "wikilink", target: "場所", heading: null, text: null },
  ]);
  assert.equal(markdownHtml("[[場所#灯台]]"), '<p><a class="wikilink" data-wikilink="場所" data-heading="灯台" href="#">場所 &gt; 灯台</a></p>');
  assert.deepEqual(parseInline("`[[x]]` \\[[y]]"), [{ t: "code", v: "[[x]]" }, { t: "text", v: " [[y]]" }]);
});

// ---- line breaks and GFM (docs/adr/0035) ----

test("line breaks: every newline a break, or CommonMark's soft breaks; blank lines part paragraphs either way", () => {
  assert.equal(markdownHtml("一行目\n二行目\n\n次", { breaks: "newline" }), "<p>一行目<br>二行目</p>\n<p>次</p>");
  assert.equal(markdownHtml("a\nb  \nc\n\nd", { breaks: "blank-line" }), "<p>a\nb<br>c</p>\n<p>d</p>");
  // a soft break between Japanese characters adds no space
  assert.equal(markdownHtml("一行目\n二行目", { breaks: "blank-line" }), "<p>一行目二行目</p>");
  assert.equal(markdownHtml("英語 word\nnext", { breaks: "blank-line" }), "<p>英語 word\nnext</p>");
});

test("strikethrough with two tildes only, not in code", () => {
  assert.deepEqual(parseInline("~~消す~~と~一つ~と`~~c~~`"), [
    { t: "del", c: [{ t: "text", v: "消す" }] },
    { t: "text", v: "と~一つ~と" },
    { t: "code", v: "~~c~~" },
  ]);
  assert.deepEqual(parseInline("~~閉じない"), [{ t: "text", v: "~~閉じない" }]);
  assert.equal(markdownHtml("~~**a**~~"), "<p><del><strong>a</strong></del></p>");
});

test("task lists in bullet and ordered lists, nested; no space after ] is no task", () => {
  assert.equal(
    markdownHtml("- [ ] 書く\n- [x] 読む\n  - [X] 入れ子\n\n1. [ ] 番号\n\n- [ ]なし"),
    '<ul><li><input type="checkbox" disabled> 書く</li><li><input type="checkbox" checked disabled> 読む<ul><li><input type="checkbox" checked disabled> 入れ子</li></ul></li></ul>\n<ol><li><input type="checkbox" disabled> 番号</li></ol>\n<ul><li>[ ]なし</li></ul>',
  );
});

test("autolinks: <url>, and URLs in text without trailing punctuation; not javascript:, not in code", () => {
  assert.equal(markdownHtml("<https://example.com/a>"), '<p><a href="https://example.com/a">https://example.com/a</a></p>');
  assert.equal(markdownHtml("見てhttps://example.com/x。"), '<p>見て<a href="https://example.com/x">https://example.com/x</a>。</p>');
  assert.equal(markdownHtml("(see www.example.com)."), '<p>(see <a href="http://www.example.com">www.example.com</a>).</p>');
  assert.equal(markdownHtml("<javascript:alert(1)>"), "<p>&lt;javascript:alert(1)&gt;</p>");
  assert.equal(markdownHtml("`https://x.y`"), "<p><code>https://x.y</code></p>");
});

test("tables: column alignment", () => {
  assert.equal(
    markdownHtml("| a | b | c | d |\n|:--|:-:|--:|---|\n| 1 | 2 | 3 | 4 |"),
    '<table><thead><tr><th style="text-align:left">a</th><th style="text-align:center">b</th><th style="text-align:right">c</th><th>d</th></tr></thead><tbody><tr><td style="text-align:left">1</td><td style="text-align:center">2</td><td style="text-align:right">3</td><td>4</td></tr></tbody></table>',
  );
});

test("a soft break with a Japanese character on either side adds no space; mailto autolinks (docs/adr/0035)", () => {
  assert.equal(markdownHtml("日本語\nword", { breaks: "blank-line" }), "<p>日本語word</p>");
  assert.equal(markdownHtml("word\n日本語", { breaks: "blank-line" }), "<p>word日本語</p>");
  assert.equal(markdownHtml("<mailto:a@b.c>"), '<p><a href="mailto:a@b.c">mailto:a@b.c</a></p>');
});

test("images: local ones under the workspace are read, remote ones are named, not loaded (docs/adr/0047)", () => {
  const base = { dir: "/w/notes", root: "/w" };
  const html = (src: string) => markdownHtml(src, { base });
  assert.equal(html("![灯台](images/a.png)"), `<p><img data-src="/w/notes/images/a.png" alt="灯台"></p>`);
  assert.equal(html("前 ![灯台](../images/a.png) 後"), `<p>前 <img data-src="/w/images/a.png" alt="灯台"> 後</p>`);
  assert.equal(html("![灯台](https://example.com/a.png)"), `<p><span class="img-note">灯台（外部の画像は読み込みません：https://example.com/a.png）</span></p>`);
  assert.equal(html("![灯台](//example.com/a.png)"), `<p><span class="img-note">灯台（外部の画像は読み込みません：//example.com/a.png）</span></p>`);
  assert.equal(html("![秘密](../../etc/a.png)"), `<p><span class="img-note">秘密（ワークスペースの外の画像は読み込みません）</span></p>`);
  assert.equal(html("![秘密](/etc/a.png)"), `<p><span class="img-note">秘密（ワークスペースの外の画像は読み込みません）</span></p>`);
  assert.doesNotMatch(markdownHtml("![a](https://example.com/a.png)"), /<img/);
});

// ---- docs/adr/0061: what CommonMark reads ----

const tx = (v: string) => ({ t: "text", v });

test("Setext headings: === is level 1, --- level 2; --- after a blank line is a rule", () => {
  assert.deepEqual(parseMarkdown("Title\n=====\nSub\n---\n\n---\n"), [
    { t: "heading", level: 1, c: [tx("Title")] },
    { t: "heading", level: 2, c: [tx("Sub")] },
    { t: "hr" },
  ]);
});

test("indented code: four spaces in, not inside a paragraph", () => {
  assert.deepEqual(parseMarkdown("    a\n      b\n\n段落\n    続き\n"), [
    { t: "code", lang: "", info: "", text: "a\n  b" },
    { t: "para", c: [tx("段落"), { t: "softbreak", cjk: true }, tx("続き")] },
  ]);
});

test("front matter at the top only, drawn as <pre> in the preview; a BOM goes", () => {
  assert.deepEqual(parseMarkdown("﻿---\ntitle: x\n---\n本文\n"), [{ t: "front", text: "title: x" }, { t: "para", c: [tx("本文")] }]);
  assert.equal(markdownHtml("---\na: 1\n...\n"), '<pre class="front-matter">a: 1</pre>');
});

test("fences: a backtick info string with a backtick is no fence; the close is as long or longer and the same character", () => {
  assert.deepEqual(parseMarkdown("```code```\n"), [{ t: "para", c: [{ t: "code", v: "code" }] }]);
  assert.deepEqual(parseMarkdown("````\n```\n~~~~\n````\n"), [{ t: "code", lang: "", info: "", text: "```\n~~~~" }]);
});

test("reference links: full, collapsed and shortcut; labels case-folded; the definitions are not drawn", () => {
  assert.equal(
    markdownHtml("[a][Foo Bar] [foo bar][] [FOO BAR]\n\n[foo  bar]: https://x.y/a\n"),
    '<p><a href="https://x.y/a">a</a> <a href="https://x.y/a">foo bar</a> <a href="https://x.y/a">FOO BAR</a></p>',
  );
  assert.equal(markdownHtml("[x][nope]\n"), "<p>[x][nope]</p>");
});

test("entities: named, decimal and hex become characters; unknown ones stay", () => {
  assert.deepEqual(parseInline("&amp; &copy; &#12354; &#x3042; &bogus; &#0;"), [tx("& © あ あ &bogus; �")]);
});

test("emphasis by the delimiter stack: across lines, ***x***, the rule of three; CJK next to a run counts as punctuation", () => {
  assert.deepEqual(parseInline("**a\nb**"), [{ t: "strong", c: [tx("a"), { t: "softbreak", cjk: false }, tx("b")] }]);
  assert.deepEqual(parseInline("***x***"), [{ t: "em", c: [{ t: "strong", c: [tx("x")] }] }]);
  assert.deepEqual(parseInline("*foo**bar**baz*"), [{ t: "em", c: [tx("foo"), { t: "strong", c: [tx("bar")] }, tx("baz")] }]);
  assert.deepEqual(parseInline("これは**「強調」**です"), [tx("これは"), { t: "strong", c: [tx("「強調」")] }, tx("です")]);
});

test("links: balanced parentheses and <...> destinations, titles, no links in links", () => {
  assert.deepEqual(parseInline('[a](b(c) "t")'), [{ t: "link", href: "b(c)", c: [tx("a")] }]);
  assert.deepEqual(parseInline("[a](<b c>)"), [{ t: "link", href: "b c", c: [tx("a")] }]);
  assert.deepEqual(parseInline("[a [b](c) d](e)"), [tx("[a "), { t: "link", href: "c", c: [tx("b")] }, tx(" d](e)")]);
});

test("quotes hold blocks; lists hold continuation lines and child blocks; numbered lists keep their start", () => {
  assert.deepEqual(parseMarkdown("> - a\n> ```\n> c\n> ```\n"), [
    { t: "quote", c: [{ t: "list", ordered: false, start: 1, tight: true, items: [{ c: [{ t: "para", c: [tx("a")] }] }] }, { t: "code", lang: "", info: "", text: "c" }] },
  ]);
  assert.deepEqual(parseMarkdown("3. a\n続き\n\n   段落\n"), [
    {
      t: "list",
      ordered: true,
      start: 3,
      tight: false,
      items: [{ c: [{ t: "para", c: [tx("a"), { t: "softbreak", cjk: true }, tx("続き")] }, { t: "para", c: [tx("段落")] }] }],
    },
  ]);
  assert.equal(markdownHtml("2. a\n3. b\n"), '<ol start="2"><li>a</li><li>b</li></ol>');
});

test("a table can end a paragraph (GFM)", () => {
  assert.deepEqual(parseMarkdown("段落\n| a |\n|---|\n").map((b) => b.t), ["para", "table"]);
});
