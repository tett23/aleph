import { test } from "node:test";
import assert from "node:assert/strict";
import { chapterFor, materialLimit, rankSections, selectMaterial, splitSections, terms } from "./material.ts";

// a token counter for the tests: one token per character
const chars = (s: string) => [...s].length;

test("ADR 0081 I9: the chapter follows the kind of the target", () => {
  assert.equal(chapterFor("chapters/01.gm"), "03-markup");
  assert.equal(chapterFor("notes/a.md"), "03-markup");
  assert.equal(chapterFor("manifest.toml"), "04-manifest");
  assert.equal(chapterFor("book/style.toml"), "05-style");
  assert.equal(chapterFor("data.json"), null);
  assert.equal(chapterFor("other.toml"), null);
});

test("ADR 0081 I9: a chapter splits at its headings; a # in a code block is not a heading", () => {
  const ch = ["@label a", "# 章", "前書き", "", "## 節一", "本文", "```", "# 例の見出し", "```", "### 項", "終わり"].join("\n");
  const s = splitSections(ch);
  assert.deepEqual(
    s.map((x) => x.title),
    ["", "章", "節一", "項"],
  );
  assert.equal(s.map((x) => x.text).join("\n"), ch);
  assert.match(s[2].text, /# 例の見出し/);
});

test("ADR 0081 I9: the terms are the identifiers of the request and the target, and the kanji and katakana pairs of the request", () => {
  const t = terms("行送りを広げて", 'line-pitch = "18H"\n[page.grid]\n');
  assert.ok(t.includes("line-pitch"));
  assert.ok(t.includes("page"));
  assert.ok(t.includes("grid"));
  assert.ok(t.includes("行送"));
  assert.ok(!t.includes("りを"));
});

test("ADR 0081 I9: the terms of a .gm target are its commands", () => {
  const t = terms("ルビを振って", "@figure a.png alt=\"x\"\n[ruby: 東京|とうきょう]\n");
  assert.ok(t.includes("figure"));
  assert.ok(t.includes("ruby"));
});

test("ADR 0081 I9: sections are ranked by the number of terms they share, ties in the order of the chapter", () => {
  const sections = [
    { title: "a", text: "nothing" },
    { title: "b", text: "line-pitch 行送" },
    { title: "c", text: "line-pitch" },
    { title: "d", text: "行送" },
  ];
  assert.deepEqual(
    rankSections(sections, ["line-pitch", "行送"]).map((s) => s.title),
    ["b", "c", "d", "a"],
  );
});

test("ADR 0081 I9: with no section of the chapter, the material is the command list only", () => {
  assert.deepEqual(selectMaterial("COMMANDS", [], 100, chars), ["COMMANDS"]);
});

test("ADR 0081 I9: sections that add up to the limit exactly all go in", () => {
  // each item counts its own length and the two characters that join it
  const items = ["aaa", "bbbb", "cc"];
  const total = items.reduce((n, s) => n + chars(s) + 2, 0);
  assert.deepEqual(selectMaterial("aaa", ["bbbb", "cc"], total, chars), items);
});

test("ADR 0081 I9: one token over the limit leaves out the section tried last", () => {
  const total = chars("aaa") + 2 + chars("bbbb") + 2 + chars("cc") + 2;
  assert.deepEqual(selectMaterial("aaa", ["bbbb", "cc"], total - 1, chars), ["aaa", "bbbb"]);
});

test("ADR 0081 I9: a large section that does not fit is skipped, and a smaller one after it goes in", () => {
  assert.deepEqual(selectMaterial("aaa", ["b".repeat(50), "cc"], 10, chars), ["aaa", "cc"]);
});

test("ADR 0081 I9: the material never goes over the limit", () => {
  const sections = Array.from({ length: 30 }, (_, i) => "x".repeat((i * 7) % 23 + 1));
  for (const limit of [0, 1, 5, 17, 40, 100, 1000]) {
    const got = selectMaterial("cmds", sections, limit, chars);
    assert.ok(got.reduce((n, s) => n + chars(s) + 2, 0) <= limit, `limit ${limit}`);
  }
});

test("ADR 0081 I9: a command list that does not fit is skipped like a section", () => {
  assert.deepEqual(selectMaterial("c".repeat(20), ["dd"], 5, chars), ["dd"]);
});

test("ADR 0081 I9: the limit is the context less the fixed part and 1,024 tokens for the answer", () => {
  assert.equal(materialLimit(4096, 500), 2572);
  assert.equal(materialLimit(1000, 500), 0);
});
