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
