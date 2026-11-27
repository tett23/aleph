import { test } from "node:test";
import assert from "node:assert/strict";
import { golemUrl, mdToGm, placeImage, type GmCtx } from "./mdgm.ts";

const gm = (md: string, sep: "blank-line" | "line" = "blank-line") => mdToGm(md, sep);

test("headings stay; the closing #s go", () => {
  assert.equal(gm("# 霧笛 #\n\n## 灯の交代\n"), "# 霧笛\n\n## 灯の交代\n");
});

test("lists: bullets become -, nesting two spaces; numbered become +; a new marker starts a new list", () => {
  assert.equal(gm("* 一\n    + 二\n        - 三\n- 四\n"), "- 一\n  - 二\n    - 三\n\n- 四\n");
  assert.equal(gm("1. 一\n2) 二\n"), "+ 一\n\n@number 2\n+ 二\n");
});

test("emphasis, italics and code become commands; nested", () => {
  assert.equal(gm("**強く**と*斜め*と`code`\n"), "[strong: 強く]と[italic: 斜め]と[code: code]\n");
  assert.equal(gm("__a *b* c__\n"), "[strong: a [italic: b] c]\n");
  assert.equal(gm("**`x*y`**\n"), "[strong: [code: x*y]]\n");
});

test("inside a prose slot ] and | are escaped; in running text they are not", () => {
  assert.equal(gm("**a]b|c**\n"), "[strong: a\\]b\\|c]\n");
  assert.equal(gm("a]b|c\n"), "a]b|c\n");
  assert.equal(gm("`[x|y]`\n"), "[code: \\[x\\|y\\]]\n");
});

test("running text: [ and \\ are escaped, and each % of a run of two or more (docs/adr/0061)", () => {
  assert.equal(gm("配列は a\\[0\\] と書く。\\\\ と 50%% 引き\n"), "配列は a\\[0] と書く。\\\\ と 50\\%\\% 引き\n");
  assert.equal(gm("\\%%% と 5%\n"), "\\%\\%\\% と 5%\n");
});

test("a paragraph starting with # - + = @ | is escaped; so is ## before a digit", () => {
  assert.equal(gm("\\# 見出しでない\n"), "\\# 見出しでない\n");
  assert.equal(gm("\\- 項目でない\n"), "\\- 項目でない\n");
  assert.equal(gm("\\+ 項目でない\n"), "\\+ 項目でない\n");
  assert.equal(gm("= 等号\n"), "\\= 等号\n");
  assert.equal(gm("@mention です\n"), "\\@mention です\n");
  assert.equal(gm("| 縦棒で始まる\n"), "\\| 縦棒で始まる\n");
  assert.equal(gm("番号は ##1 と書く\n"), "番号は \\##1 と書く\n");
});

test("http(s) links become [link]; others keep their text; an image alone on a line becomes @nonumber @figure (docs/adr/0061)", () => {
  assert.equal(gm("[Golem](https://example.com) を見る\n"), '[link "https://example.com": Golem] を見る\n');
  assert.equal(gm("[章](chapters/a.md) と [m](mailto:a@b.c)\n"), "章 と m\n");
  assert.equal(gm('![灯台の絵](images/lighthouse.png "t")\n'), '@nonumber\n@figure "images/lighthouse.png" alt="灯台の絵"\n');
});

test("quotes lose the mark; rules become a blank line; tables and code blocks stay", () => {
  assert.equal(gm("> 引用\n> 続き\n\n---\n\n後\n"), "引用\n続き\n\n後\n");
  assert.equal(gm("| a | b |\n|---|---|\n| 1 | 2 |\n"), "| a | b |\n|---|---|\n| 1 | 2 |\n");
  assert.equal(gm("```gm\n[ruby: x|y] **z** %%\n```\n"), "```gm\n[ruby: x|y] **z** %%\n```\n");
});

test("two trailing spaces become a forced break", () => {
  assert.equal(gm("一行目  \n二行目\n"), "一行目\\\n二行目\n");
});

test("paragraphs: kept as lines in the blank-line style, joined into one line in the line style", () => {
  const md = "一行目\n二行目\n\n次の段落\n";
  assert.equal(gm(md, "blank-line"), "一行目\n二行目\n\n次の段落\n");
  assert.equal(gm(md, "line"), "一行目二行目\n\n次の段落\n");
  assert.equal(gm("一  \n二\n三\n", "line"), "一\\\n二三\n");
});

test("an image alone on its line becomes @figure even when text follows on the next line", () => {
  assert.equal(gm("![a](x.png)\n次の行\n"), '@nonumber\n@figure "x.png" alt="a"\n\n次の行\n');
});

test("a wikilink keeps only the text it shows (docs/adr/0027)", () => {
  assert.equal(mdToGm("[[人物|父]]と[[場所]]", "blank-line").trim(), "父と場所");
});

test("GFM in gm: strikethrough keeps its text, task marks become ☐ and ☑, autolinks their URL (docs/adr/0035)", () => {
  assert.equal(mdToGm("~~消す~~と https://x.y", "blank-line").trim(), '消すと [link "https://x.y"]');
  assert.equal(mdToGm("- [ ] 書く\n- [x] 読む", "blank-line").trim(), "- ☐ 書く\n- ☑ 読む");
});

// ---- docs/adr/0061: each rule with the gm checked with golem 0.1.0-rc4 ----

const inChapters: GmCtx = { dir: "chapters", resolveEmbed: (t) => (t === "pic.png" ? "images/pic.png" : null) };

test("soft breaks: a space between non-CJK characters, the line kept (blank-line) or joined (line) next to CJK", () => {
  assert.equal(gm("hello\nworld\n"), "hello world\n");
  assert.equal(gm("hello\nworld\n", "line"), "hello world\n");
  assert.equal(gm("日本\n語\n"), "日本\n語\n");
  assert.equal(gm("日本\n語\n", "line"), "日本語\n");
  assert.equal(gm("word\n日本\n", "line"), "word日本\n");
});

test("hard breaks: a trailing \; inside a prose slot the command is closed and opened again; no empty line", () => {
  assert.equal(gm("**a  \nb**\n"), "[strong: a]\\\n[strong: b]\n");
  assert.equal(gm("a\\\n\\\nb\n"), "a\\\nb\n");
});

test("tables are written anew: cells padded or cut to the head, | escaped, alignment kept", () => {
  assert.equal(gm("| a | b |\n|:--|--:|\n| **x** |\n"), "| a | b |\n|:---|---:|\n| [strong: x] |  |\n");
  assert.equal(gm("a | b\n--|--\n1 | 2 | 3\n"), "| a | b |\n|---|---|\n| 1 | 2 |\n");
  assert.equal(gm("| [x] | y] | 50%% | ##1 | `a\\|b` |\n|---|---|---|---|---|\n"), "| \\[x] | y] | 50\\%\\% | \\##1 | [code: a\\|b] |\n|---|---|---|---|---|\n");
  assert.equal(gm("- 項目\n\n  | a |\n  |---|\n  | 1 |\n"), "- 項目\n\n  | a |\n  |---|\n  | 1 |\n");
});

test("code blocks: only a plain first word of the info string; a ``` line inside gets a space; indented code is fenced", () => {
  assert.equal(gm("```js title=x\na\n```\n"), "```js\na\n```\n");
  assert.equal(gm("```c++\na\n```\n"), "```c++\na\n```\n");
  assert.equal(gm("```{.python}\na\n```\n"), "```\na\n```\n");
  assert.equal(gm("````\n```\nx\n````\n"), "```\n ```\nx\n```\n");
  assert.equal(gm("    code\n      more\n"), "```\ncode\n  more\n```\n");
});

test("figures: @nonumber @figure from the project's root, quoted; remote images a link; other images their alt and a comment", () => {
  assert.equal(mdToGm("![灯台](../images/my%20image.png?raw=true)\n", "blank-line", inChapters), '@nonumber\n@figure "images/my image.png" alt="灯台"\n');
  assert.equal(mdToGm('![a\\\\](x.png)\n', "blank-line", inChapters), '@nonumber\n@figure "chapters/x.png" alt="a\\\\"\n');
  assert.equal(gm("![外の画像](https://example.com/a.png)\n"), '[link "https://example.com/a.png": 外の画像]\n');
  assert.equal(gm("![](https://example.com/a.png)\n"), '[link "https://example.com/a.png"]\n');
  assert.equal(gm("![動く図](images/anim.gif)\n"), "動く図 %% 画像: images/anim.gif %%\n");
  assert.equal(gm("![上](/abs.png)\n"), "上 %% 画像: /abs.png %%\n");
  assert.equal(mdToGm("![外](../../x.png)\n", "blank-line", inChapters), "外 %% 画像: ../../x.png %%\n");
  assert.equal(gm("![%%](a.webp)\n"), "\\%\\% %% 画像: a.webp %%\n");
  assert.deepEqual(placeImage("a%25%25.png", null), { k: "figure", path: "a%%.png" });
});

test("embeds: an image found is a figure with its stem as alt; one not found its stem and a comment; a sheet its name, guarded", () => {
  assert.equal(mdToGm("![[pic.png]]\n", "blank-line", inChapters), '@nonumber\n@figure "images/pic.png" alt="pic"\n');
  assert.equal(mdToGm("![[none.png]]\n", "blank-line", inChapters), "none %% 画像: none.png %%\n");
  assert.equal(gm("![[@x]]\n"), "\\@x\n");
});

test("links: http(s) to [link], URL fixed to RFC 3986, autolinks bare, www. with http://, empty text dropped, others text", () => {
  assert.equal(gm("[a](https://x.y/[x])\n"), '[link "https://x.y/%5Bx%5D": a]\n');
  assert.equal(gm("<https://example.com/%25%2541>\n"), '[link "https://example.com/%25%2541"]\n');
  assert.equal(gm("[値](https://xn--fsq.jp/パス?q=値)\n"), '[link "https://xn--fsq.jp/パス?q=値": 値]\n');
  assert.equal(gm("www.a.b を見る\n"), '[link "http://www.a.b": www.a.b] を見る\n');
  assert.equal(gm("[](https://x.y)と\n"), "と\n");
  assert.equal(gm("<http://例.jp/>\n"), "http://例.jp/\n");
  assert.equal(golemUrl("https://x.y/a b%zz"), "https://x.y/a%20b%25zz");
  assert.equal(golemUrl("http://www.a.b+["), null);
  assert.equal(gm("# 見出しの[リンク](https://x.y)\n"), '# 見出しの[link "https://x.y": リンク]\n');
});

test("lists: an empty item is [= \"\"]; a start not 1 (or a later ordered list) gets @number; children two spaces deeper", () => {
  assert.equal(gm("- \n- b\n"), '- [= ""]\n- b\n');
  assert.equal(gm("3. a\n4. b\n"), "@number 3\n+ a\n+ b\n");
  assert.equal(gm("0. a\n"), "@number 0\n+ a\n");
  assert.equal(gm("1. a\n\n> 1. b\n"), "+ a\n\n@number 1\n+ b\n");
  assert.equal(gm("- a\n  続き\n- b\n"), "- a続き\n- b\n");
  assert.equal(gm("- one\n  two\n"), "- one two\n");
  assert.equal(gm("- a\n\n  段落\n- b\n"), "- a\n\n  段落\n- b\n");
  assert.equal(gm("- a\n  ```\n  x\n  ```\n"), "- a\n\n  ```\n  x\n  ```\n");
});

test("quotes: the blocks inside written as outside; headings become paragraphs; nested quotes flat", () => {
  assert.equal(gm("> # 題\n> - a\n>\n> > 入れ子\n"), "題\n\n- a\n\n入れ子\n");
  assert.equal(gm("> ```\n> code\n> ```\n", "line"), "```\ncode\n```\n");
});

test("front matter, link definitions and rules write nothing; Setext headings are headings", () => {
  assert.equal(gm("---\ntitle: x\n---\n本文\n"), "本文\n");
  assert.equal(gm("[a][r]\n\n[r]: https://r.example/x\n"), '[link "https://r.example/x": a]\n');
  assert.equal(gm("Title\n=====\n\nSub\n---\n"), "# Title\n\n## Sub\n");
});

test("a paragraph line that would start a Golem block is escaped, ``` too", () => {
  assert.equal(gm("a```b\n\n```a`b\n"), "a```b\n\n\\```a`b\n");
});
