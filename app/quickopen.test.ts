import { test } from "node:test";
import assert from "node:assert/strict";
import { rankSheets, sheetsOf, type Sheet } from "./quickopen.ts";

const sheets: Sheet[] = [
  { path: "/w/novel/chapters/01.gm", rel: "novel/chapters/01.gm", title: "霧笛" },
  { path: "/w/novel/chapters/02.gm", rel: "novel/chapters/02.gm", title: "母の部屋" },
  { path: "/w/notes/characters.md", rel: "notes/characters.md", title: "人物相関" },
  { path: "/w/novel/style.toml", rel: "novel/style.toml" },
];

test("an empty query lists the recent sheets in their order", () => {
  assert.deepEqual(rankSheets(sheets, "", ["/w/novel/style.toml", "/w/gone.md", "/w/novel/chapters/01.gm"]).map((s) => s.path), ["/w/novel/style.toml", "/w/novel/chapters/01.gm"]);
});

test("a query matches the title or the path, the higher of the two counting", () => {
  assert.deepEqual(rankSheets(sheets, "霧笛", []).map((s) => s.path), ["/w/novel/chapters/01.gm"]);
  assert.deepEqual(rankSheets(sheets, "style", []).map((s) => s.path), ["/w/novel/style.toml"]);
  assert.equal(rankSheets(sheets, "chars", [])[0].path, "/w/notes/characters.md");
  assert.deepEqual(rankSheets(sheets, "zzz", []), []);
});

test("recent sheets get a bonus, newer more", () => {
  const two = [
    { path: "/w/a/note.md", rel: "a/note.md" },
    { path: "/w/b/note.md", rel: "b/note.md" },
  ];
  assert.deepEqual(rankSheets(two, "note", []).map((s) => s.path), ["/w/a/note.md", "/w/b/note.md"]);
  assert.deepEqual(rankSheets(two, "note", ["/w/b/note.md"]).map((s) => s.path), ["/w/b/note.md", "/w/a/note.md"]);
});

test("the list is cut at 50", () => {
  const many = Array.from({ length: 80 }, (_, i) => ({ path: `/w/n${i}.md`, rel: `n${i}.md` }));
  assert.equal(rankSheets(many, "n", []).length, 50);
});

test("the marks come from the field that matched best", () => {
  const r = rankSheets(sheets, "霧笛", [])[0];
  assert.deepEqual([r.field, r.marks], ["title", [0, 1]]);
  const p = rankSheets(sheets, "style", [])[0];
  assert.equal(p.field, "rel");
});

test("the candidates are the files the tree shows, folded folders included", () => {
  const f = (path: string) => ({ path, name: path.split("/").pop()!, dir: false, children: [] });
  const entries = [
    { path: "/w/novel", name: "novel", dir: true, children: [f("/w/novel/01.gm"), f("/w/novel/cover.psd"), { path: "/w/novel/sub", name: "sub", dir: true, children: [f("/w/novel/sub/a.md")] }] },
    f("/w/data.json"),
  ];
  const titles = new Map([["/w/novel/01.gm", "霧笛"]]);
  assert.deepEqual(sheetsOf(entries, "/w", titles), [
    { path: "/w/novel/01.gm", rel: "novel/01.gm", title: "霧笛" },
    { path: "/w/novel/sub/a.md", rel: "novel/sub/a.md", title: undefined },
    { path: "/w/data.json", rel: "data.json", title: undefined },
  ]);
});
