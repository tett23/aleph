import { test } from "node:test";
import assert from "node:assert/strict";
import { chapterBody, xhtmlPath } from "./xhtml.ts";

const doc = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="ja">
<head><meta charset="UTF-8"/><title>霧笛</title><link rel="stylesheet" type="text/css" href="../style.css"/><style>p{}</style></head>
<body class="vertical">
<h1 id="h-1-37"><span class="number">第一章</span>　霧笛</h1>
<p><ruby>霧笛<rp>（</rp><rt>むてき</rt><rp>）</rp></ruby>は三度鳴り。残りは12リットル。</p>
<script>alert(1)</script>
<table><tr><td>a</td></tr></table>
<figure><img src="../images/lighthouse.png" alt="灯台" onerror="x()"/><figcaption>灯台</figcaption></figure>
<p><a href="javascript:x()">x</a></p>
</body>
</html>`;

test("the body without scripts, styles and links; headings, ruby, tables kept", () => {
  const { html } = chapterBody(doc);
  assert.match(html, /^<h1 id="h-1-37"><span class="number">第一章<\/span>　霧笛<\/h1>/);
  assert.match(html, /<ruby>霧笛<rp>（<\/rp><rt>むてき<\/rt><rp>）<\/rp><\/ruby>/);
  assert.match(html, /<table><tr><td>a<\/td><\/tr><\/table>/);
  assert.doesNotMatch(html, /script|alert|<style|<link|onerror|javascript:/);
});

test("the images it refers to, to be read from the build directory", () => {
  const { images } = chapterBody(doc);
  assert.deepEqual(images, ["../images/lighthouse.png"]);
});

test("no body, nothing", () => {
  assert.deepEqual(chapterBody("<html></html>"), { html: "", images: [] });
});

test("where golem build puts a chapter's XHTML", () => {
  assert.equal(xhtmlPath("/w/p", "/w/p/chapters/01.gm"), "/w/p/build/html/chapters/01.xhtml");
});
