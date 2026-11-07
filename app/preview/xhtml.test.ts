import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitize, xhtmlPath, type XNode } from "./xhtml.ts";

// A small reader of tags for the tests (the app reads with DOMParser): enough
// to give the sanitizer the trees a browser would give it.
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[e.toLowerCase()],
  );
const VOID = new Set(["br", "hr", "img", "meta", "link", "base", "embed"]);
const parse = (src: string): XNode[] => {
  const root: XNode & { kind: "el" } = { kind: "el", tag: "#root", attrs: [], children: [] };
  const stack = [root];
  const re = /<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:\s*\/?\s*[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+|<)/g;
  for (const m of src.matchAll(re)) {
    const top = stack[stack.length - 1];
    if (m[1]) {
      const i = stack.map((n) => n.tag).lastIndexOf(m[1].toLowerCase());
      if (i > 0) stack.length = i;
    } else if (m[2]) {
      const attrs: [string, string][] = [...m[3].matchAll(/([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)].map((a) => [a[1].toLowerCase(), decode(a[2] ?? a[3] ?? a[4] ?? "")]);
      const el: XNode & { kind: "el" } = { kind: "el", tag: m[2].toLowerCase(), attrs, children: [] };
      top.children.push(el);
      if (!m[4] && !VOID.has(el.tag)) stack.push(el);
    } else top.children.push({ kind: "text", text: decode(m[5]) });
  }
  return root.children;
};

const place = { dir: "/w/p/build/html/chapters", root: "/w/p/build/html" };
const clean = (src: string) => sanitize(parse(src), place);

const doc = `<h1 id="h-1-37" epub:type="title"><span class="number">第一章</span>　霧笛</h1>
<p><ruby>霧笛<rp>（</rp><rt>むてき</rt><rp>）</rp></ruby>は三度鳴り。残りは12リットル。<a href="#fn-1"><sup>1</sup></a></p>
<script>alert(1)</script>
<table><thead><tr><th colspan="2">a</th></tr></thead><tbody><tr><td rowspan="1">b</td></tr></tbody></table>
<figure><img src="../images/lighthouse.png" alt="灯台" onerror="x()"/><figcaption>灯台</figcaption></figure>
<details open=""><summary>注</summary><p>中身</p></details>`;

test("headings, ruby, tables, figures, footnote links and folding stay", () => {
  const { html } = clean(doc);
  assert.match(html, /^<h1 id="h-1-37" data-epub-type="title"><span class="number">第一章<\/span>　霧笛<\/h1>/);
  assert.match(html, /<ruby>霧笛<rp>（<\/rp><rt>むてき<\/rt><rp>）<\/rp><\/ruby>/);
  assert.match(html, /<a href="#fn-1"><sup>1<\/sup><\/a>/);
  assert.match(html, /<table><thead><tr><th colspan="2">a<\/th><\/tr><\/thead><tbody><tr><td rowspan="1">b<\/td><\/tr><\/tbody><\/table>/);
  assert.match(html, /<figure><img alt="灯台" data-src="\/w\/p\/build\/html\/images\/lighthouse.png"><figcaption>灯台<\/figcaption><\/figure>/);
  assert.match(html, /<details open=""><summary>注<\/summary><p>中身<\/p><\/details>/);
  assert.doesNotMatch(html, /script|alert|onerror/);
});

test("the images it refers to are the absolute paths under build/html", () => {
  assert.deepEqual(clean(doc).images, ["/w/p/build/html/images/lighthouse.png"]);
});

test("the payloads of the audit leave nothing that runs", () => {
  const payloads = [
    `<img src=x onerror=alert(1)>`,
    `<svg/onload=alert(1)>`,
    `<a href='javascript:alert(1)'>x</a>`,
    `<a href="&#106;avascript:alert(1)">x</a>`,
    `<a href="java&#x09;script:alert(1)">x</a>`,
    `<a href=" JAVASCRIPT:alert(1)">x</a>`,
    `<a href="data:text/html,<script>alert(1)</script>">x</a>`,
    `<iframe srcdoc="<script>alert(1)</script>"></iframe>`,
    `<object data="javascript:alert(1)"></object>`,
    `<embed src="x.swf">`,
    `<script>alert(1)</script>`,
    `<p style="background:url(javascript:alert(1))">x</p>`,
    `<form action="https://e.example"><input></form>`,
    `<base href="https://e.example/">`,
    `<p onclick="alert(1)" onmouseover='alert(1)'>x</p>`,
    `<math><mtext><script>alert(1)</script></mtext></math>`,
  ];
  for (const p of payloads) {
    const { html } = clean(p);
    assert.doesNotMatch(html, /<(script|svg|iframe|object|embed|form|base|style|input|math)\b|\bon\w+=|javascript:|srcdoc|style=|data:/i, p);
  }
});

test("text and attribute values are escaped again", () => {
  const { html } = clean(`<p title="a&quot;b">&lt;script&gt;x</p>`);
  assert.equal(html, `<p title="a&quot;b">&lt;script&gt;x</p>`);
});

test("other tags keep only their text; dropped tags lose their contents", () => {
  assert.equal(clean(`<p><font color="red">赤</font><u>下</u></p>`).html, `<p>赤下</p>`);
  assert.equal(clean(`<p>a<style>p{}</style><script>x()</script>b</p>`).html, `<p>ab</p>`);
});

test("links keep #, relative paths and http(s)", () => {
  const hrefs = (src: string) => clean(src).html;
  assert.equal(hrefs(`<a href="#a">x</a>`), `<a href="#a">x</a>`);
  assert.equal(hrefs(`<a href="02.xhtml#a">x</a>`), `<a href="02.xhtml#a">x</a>`);
  assert.equal(hrefs(`<a href="https://example.com/">x</a>`), `<a href="https://example.com/">x</a>`);
  assert.equal(hrefs(`<a href="mailto:a@example.com">x</a>`), `<a>x</a>`);
  assert.equal(hrefs(`<a href="//example.com/">x</a>`), `<a>x</a>`);
  assert.equal(hrefs(`<a href="/etc/passwd">x</a>`), `<a>x</a>`);
});

test("images outside build/html are dropped and show their alt text", () => {
  for (const src of ["../../../secret.png", "/etc/passwd", "https://example.com/a.png", "file:///etc/passwd", "data:image/png;base64,AAAA"]) {
    const r = clean(`<img src="${src}" alt="図">`);
    assert.equal(r.html, `<span class="img-alt">図</span>`, src);
    assert.deepEqual(r.images, []);
  }
  assert.deepEqual(clean(`<img src="./a.png">`).images, ["/w/p/build/html/chapters/a.png"]);
});

test("no body, nothing", () => {
  assert.deepEqual(sanitize([], place), { html: "", images: [] });
});

test("where golem build puts a chapter's XHTML", () => {
  assert.equal(xhtmlPath("/w/p", "/w/p/chapters/01.gm"), "/w/p/build/html/chapters/01.xhtml");
});
