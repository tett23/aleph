import { test } from "node:test";
import assert from "node:assert/strict";
import { api } from "./api.ts";
import { inlineHtml, markdownHtml, markdownHtmlBlocks, type Block } from "./md.ts";

test("HTML renderer escapes parsed content and blocks dangerous links", async () => {
  assert.equal(inlineHtml([{ t: "text", v: "<script>" }]), "&lt;script&gt;");
  assert.equal(inlineHtml([{ t: "link", href: "javascript:run()", c: [{ t: "text", v: "x" }] }]), '<a href="#">x</a>');
  assert.equal(await markdownHtmlBlocks([{ t: "heading", level: 1, c: [{ t: "text", v: "a <b>" }] }]), "<h1>a &lt;b&gt;</h1>");
});

test("nested lists and line break options retain their rendering", async () => {
  const list: Block = { t: "list", items: [
    { depth: 0, ordered: false, c: [{ t: "text", v: "a" }] },
    { depth: 1, ordered: false, c: [{ t: "text", v: "b" }] },
    { depth: 0, ordered: false, c: [{ t: "text", v: "c" }] },
  ] };
  assert.equal(await markdownHtmlBlocks([list]), "<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>");
  const paragraph: Block = { t: "para", lines: [
    { c: [{ t: "text", v: "一行目" }], hard: false },
    { c: [{ t: "text", v: "二行目" }], hard: false },
  ] };
  assert.equal(await markdownHtmlBlocks([paragraph], { breaks: "newline" }), "<p>一行目<br>二行目</p>");
  assert.equal(await markdownHtmlBlocks([paragraph], { breaks: "blank-line" }), "<p>一行目二行目</p>");
});

test("tables draw structured cells from the Rust table API", async () => {
  const original = api.parseMarkdownTable;
  let seen: string[] = [];
  api.parseMarkdownTable = async (rows) => { seen = rows; return {
    head: [[{ t: "text", v: "a" }], [{ t: "text", v: "b" }]],
    body: [[[{ t: "text", v: "1" }], [{ t: "text", v: "2" }]]],
    aligns: ["left", "right"],
  }; };
  try {
    const blocks: Block[] = [{ t: "table", rows: ["| a | b |", "|:--|--:|", "| 1 | 2 |"] }];
    assert.equal(await markdownHtmlBlocks(blocks), '<table><thead><tr><th style="text-align:left">a</th><th style="text-align:right">b</th></tr></thead><tbody><tr><td style="text-align:left">1</td><td style="text-align:right">2</td></tr></tbody></table>');
    assert.deepEqual(seen, ["| a | b |", "|:--|--:|", "| 1 | 2 |"]);
  } finally { api.parseMarkdownTable = original; }
});

test("Markdown uses the Rust block API", async () => {
  const original = api.parseMarkdown;
  api.parseMarkdown = async () => [{ t: "para", lines: [{ c: [{ t: "text", v: "Rust" }], hard: false }] }];
  try { assert.equal(await markdownHtml("ignored"), "<p>Rust</p>"); }
  finally { api.parseMarkdown = original; }
});

test("local images stay in the workspace and remote images are not loaded", async () => {
  const base = { dir: "/w/notes", root: "/w" };
  const image = (src: string): Block[] => [{ t: "image", src, alt: "灯台" }];
  assert.equal(await markdownHtmlBlocks(image("images/a.png"), { base }), '<p><img data-src="/w/notes/images/a.png" alt="灯台"></p>');
  assert.match(await markdownHtmlBlocks(image("https://x.test/a.png"), { base }), /外部の画像は読み込みません/);
  assert.match(await markdownHtmlBlocks(image("../../etc/a.png"), { base }), /ワークスペースの外/);
});
