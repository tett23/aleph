import { test } from "node:test";
import assert from "node:assert/strict";
import { backlinks, buildIndex, completeAt, findHeading, markMissing, parseWikilinks, renameEdits, resolveLink, type Sheet } from "./wikilink.ts";

test("the forms of a link: target, label, heading, and a heading of the same sheet", () => {
  const ls = parseWikilinks("[[霧笛]] [[ 人物 | 父 ]] [[場所#灯台]] [[場所#灯台|あの灯台]] [[#前の章]]");
  assert.deepEqual(
    ls.map((l) => [l.target, l.heading, l.label]),
    [
      ["霧笛", null, null],
      ["人物", null, "父"],
      ["場所", "灯台", null],
      ["場所", "灯台", "あの灯台"],
      ["", "前の章", null],
    ],
  );
});

test("each link's place in UTF-16 units, the target's too", () => {
  const [a, b] = parseWikilinks("𠮷[[𩸽]]と[[x|y]]");
  assert.deepEqual([a.from, a.to, a.targetFrom, a.targetTo], [2, 8, 4, 6]);
  assert.deepEqual([b.from, b.to, b.targetFrom, b.targetTo], [9, 16, 11, 12]);
});

test("not links: code spans, code blocks, an escaped [[, an unclosed [[, a target with ]", () => {
  assert.deepEqual(parseWikilinks("`[[a]]` \\[[b]] [[c"), []);
  assert.deepEqual(parseWikilinks("```\n[[a]]\n```\n[[b]]").map((l) => l.target), ["b"]);
  assert.deepEqual(parseWikilinks("[[]]"), []);
  assert.deepEqual(parseWikilinks("[[a]b]]"), []);
});

const sheets: Sheet[] = [
  { path: "/w/notes/人物.md", title: "登場人物" },
  { path: "/w/notes/場所.md", title: "場所" },
  { path: "/w/notes/sub/場所.md" },
  { path: "/w/novel/chapters/01.gm", title: "霧笛" },
  { path: "/w/novel/人物.gm" },
  { path: "/w/other/人物.md" },
  { path: "/w/notes/data.toml" },
];
const WS = "/w";

test("a target with a slash or an extension is a path: from the sheet's folder, then the root; .md added", () => {
  assert.deepEqual(resolveLink("sub/場所", "/w/notes/a.md", sheets, WS), { path: "/w/notes/sub/場所.md", ambiguous: false });
  assert.deepEqual(resolveLink("novel/人物.gm", "/w/notes/a.md", sheets, WS), { path: "/w/novel/人物.gm", ambiguous: false });
  assert.deepEqual(resolveLink("data.toml", "/w/notes/a.md", sheets, WS), { path: "/w/notes/data.toml", ambiguous: false });
  assert.deepEqual(resolveLink("no/such", "/w/notes/a.md", sheets, WS), { path: null, ambiguous: false });
});

test("a file name: .md before .gm, the same folder first, then the nearest, else the first by path and ambiguous", () => {
  assert.equal(resolveLink("人物", "/w/notes/a.md", sheets, WS).path, "/w/notes/人物.md");
  assert.equal(resolveLink("人物", "/w/other/x.md", sheets, WS).path, "/w/other/人物.md");
  assert.deepEqual(resolveLink("人物", "/w/top.md", sheets, WS), { path: "/w/notes/人物.md", ambiguous: true });
  assert.equal(resolveLink("場所", "/w/notes/sub/x.md", sheets, WS).path, "/w/notes/sub/場所.md");
});

test("a sheet's name (its first heading) when no file name matches", () => {
  assert.equal(resolveLink("霧笛", "/w/notes/a.md", sheets, WS).path, "/w/novel/chapters/01.gm");
  assert.equal(resolveLink("登場人物", "/w/notes/a.md", sheets, WS).path, "/w/notes/人物.md");
});

test("names compare after NFC, and case counts", () => {
  const nfd = "パス"; // パス in NFD
  const s: Sheet[] = [{ path: "/w/パス.md" }];
  assert.equal(resolveLink(nfd, "/w/a.md", s, WS).path, "/w/パス.md");
  assert.equal(resolveLink("ぱす", "/w/a.md", s, WS).path, null);
  assert.equal(resolveLink("readme", "/w/a.md", [{ path: "/w/README.md" }], WS).path, null);
});

test("a heading is found by its text in .md and .gm; none gives null", () => {
  assert.equal(findHeading("# 題\n\n## 灯台\n本文", "md", "灯台"), 3);
  assert.equal(findHeading("```\n# 灯台\n```\n# 灯台", "md", "灯台"), 4);
  assert.equal(findHeading("# 題\n## 灯台", "gm", "灯台"), 2);
  assert.equal(findHeading("# 題", "md", "ない"), null);
});

test("the index gives each sheet's backlinks with the linking line, and follows changes", () => {
  const texts = new Map([
    ["/w/notes/a.md", "父は[[人物]]にいる\n二行目 [[霧笛]]"],
    ["/w/notes/b.md", "[[登場人物|父]]"],
  ]);
  let idx = buildIndex(texts, sheets, WS);
  assert.deepEqual(
    backlinks(idx, "/w/notes/人物.md").map((b) => [b.from, b.line, b.text]),
    [
      ["/w/notes/a.md", 1, "父は[[人物]]にいる"],
      ["/w/notes/b.md", 1, "[[登場人物|父]]"],
    ],
  );
  assert.deepEqual(backlinks(idx, "/w/novel/chapters/01.gm").map((b) => b.line), [2]);
  texts.set("/w/notes/a.md", "なし");
  texts.delete("/w/notes/b.md");
  idx = buildIndex(texts, sheets, WS);
  assert.deepEqual(backlinks(idx, "/w/notes/人物.md"), []);
});

test("completion after [[ : file names and sheet names by prefix; after # : the target's headings", () => {
  const c = completeAt("見て[[人", 5, sheets, () => "");
  assert.ok(c);
  assert.equal(c!.from, 4);
  assert.deepEqual([...new Set(c!.items.map((i) => i.label))].sort(), ["人物"]);
  assert.equal(c!.items[0].apply, "人物]]");
  // ]] already there is not doubled
  assert.equal(completeAt("[[霧]]", 3, sheets, () => "")!.items[0].apply, "霧笛");
  const h = completeAt("[[場所#灯", 6, sheets, (p) => (p === "/w/notes/場所.md" ? "# 場所\n## 灯台\n## 港" : ""), "/w/notes/a.md", WS);
  assert.deepEqual(h!.items.map((i) => i.label), ["灯台"]);
  assert.equal(h!.from, 5);
  assert.equal(completeAt("[[a]] b", 7, sheets, () => ""), null);
});

test("a rename rewrites links by path and by file name, keeping labels and headings; not those by sheet name", () => {
  const text = "[[人物]] [[notes/人物|父]] [[人物#家族]] [[登場人物]] [[場所]]";
  const edits = renameEdits(text, "/w/top.md", "/w/notes/人物.md", "/w/notes/家族.md", sheets, WS);
  const out = edits.reduceRight((s, e) => s.slice(0, e.from) + e.insert + s.slice(e.to), text);
  assert.equal(out, "[[家族]] [[notes/家族|父]] [[家族#家族]] [[登場人物]] [[場所]]");
});

// ---- found in the review against the ADRs ----

test("an image path resolves to the image (docs/adr/0029)", () => {
  const s: Sheet[] = [{ path: "/w/notes/images/a.png" }, { path: "/w/notes/images/b.jpg" }, { path: "/w/notes/x.md" }];
  assert.equal(resolveLink("images/a.png", "/w/notes/x.md", s, "/w").path, "/w/notes/images/a.png");
  assert.equal(resolveLink("images/b.jpg", "/w/notes/x.md", s, "/w").path, "/w/notes/images/b.jpg");
});

test("the preview's links to missing targets are marked (docs/adr/0027)", () => {
  const html = '<p><a class="wikilink" data-wikilink="人物" href="#">人物</a> <a class="wikilink" data-wikilink="未定&amp;仮" href="#">x</a></p>';
  assert.equal(
    markMissing(html, (t) => t === "人物"),
    '<p><a class="wikilink" data-wikilink="人物" href="#">人物</a> <a class="wikilink missing" data-wikilink="未定&amp;仮" href="#">x</a></p>',
  );
});
