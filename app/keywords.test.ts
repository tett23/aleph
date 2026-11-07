import { test } from "node:test";
import assert from "node:assert/strict";
import { addKeyword, collectKeywords, plotKeywords, plotSheetsWith, removeEverywhere, removeKeyword, renameEverywhere, sheetsWith, suggest, type Root } from "./keywords.ts";

test("adding trims, skips empty and repeated ones, joins NFC and NFD, keeps the order", () => {
  let k = addKeyword([], " 父 ");
  k = addKeyword(k, "灯台");
  k = addKeyword(k, "");
  k = addKeyword(k, "父");
  assert.deepEqual(k, ["父", "灯台"]);
  assert.deepEqual(addKeyword(["パス"], "パス"), ["パス"]);
  assert.deepEqual(addKeyword(["a"], "A"), ["a", "A"]);
  assert.deepEqual(removeKeyword(["父", "灯台", "霧"], "灯台"), ["父", "霧"]);
});

const roots: Root[] = [
  { root: "/w/p", meta: { "chapters/01.gm": { note: "", done: [], keywords: ["父", "灯台"] }, "chapters/02.gm": { note: "", done: [], keywords: ["父"] } } },
  { root: "/w", meta: { "notes/a.md": { note: "", done: [], keywords: ["霧", "父"] }, "notes/b.md": { note: "x", done: [] } } },
];

test("collecting: counts across roots, by name", () => {
  assert.deepEqual(collectKeywords(roots), [
    { keyword: "灯台", count: 1 },
    { keyword: "父", count: 3 },
    { keyword: "霧", count: 1 },
  ].sort((a, b) => a.keyword.localeCompare(b.keyword, "ja")));
});

test("the plot's keywords by source", () => {
  const rows = [
    { pov: "私", characters: "父、私", place: "灯台", subplots: "手紙" },
    { pov: "", characters: "父", place: "港", subplots: "" },
  ];
  assert.deepEqual(plotKeywords(rows), { pov: ["私"], characters: ["父", "私"], place: ["灯台", "港"], subplots: ["手紙"] });
});

test("the sheets with one keyword, and with all of several", () => {
  assert.deepEqual(sheetsWith(roots, ["父"]), ["/w/notes/a.md", "/w/p/chapters/01.gm", "/w/p/chapters/02.gm"]);
  assert.deepEqual(sheetsWith(roots, ["父", "灯台"]), ["/w/p/chapters/01.gm"]);
  assert.deepEqual(sheetsWith(roots, []), []);
});

test("renaming everywhere, merging into an existing name; removing everywhere", () => {
  const m = { "a.gm": { note: "", done: [], keywords: ["父", "灯台"] }, "b.gm": { note: "", done: [], keywords: ["父さん", "父"] } };
  const r = renameEverywhere(m, "父さん", "父");
  assert.deepEqual([r["a.gm"].keywords, r["b.gm"].keywords], [["父", "灯台"], ["父"]]);
  const x = removeEverywhere(m, "父");
  assert.deepEqual([x["a.gm"].keywords, x["b.gm"].keywords], [["灯台"], ["父さん"]]);
});

test("suggestions start with what was typed, the most used first", () => {
  const all = [
    { keyword: "灯台", count: 1 },
    { keyword: "灯台守", count: 4 },
    { keyword: "父", count: 3 },
  ];
  assert.deepEqual(suggest(all, "灯"), ["灯台守", "灯台"]);
  assert.deepEqual(suggest(all, ""), ["灯台守", "父", "灯台"]);
});

test("the sheets whose plot rows name a keyword", () => {
  const plots = [
    { project: "/w/p", rows: [{ pov: "私", characters: "父、私", place: "灯台", subplots: "", file: "chapters/01.gm" }, { pov: "", characters: "父", place: "港", subplots: "", file: "chapters/02.gm" }, { pov: "", characters: "父", place: "", subplots: "", file: "" }] },
  ];
  assert.deepEqual(plotSheetsWith(plots, "父"), ["/w/p/chapters/01.gm", "/w/p/chapters/02.gm"]);
  assert.deepEqual(plotSheetsWith(plots, "灯台"), ["/w/p/chapters/01.gm"]);
});
