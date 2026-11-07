import { test } from "node:test";
import assert from "node:assert/strict";
import { moveBookmark, parseBookmarks, relocate, removeBookmark, renameBookmarks, toggleBookmark, writeBookmarks, type Bookmark } from "./bookmarks.ts";

const sheet = (path: string): Bookmark => ({ path });
const line = (path: string, n: number, text: string): Bookmark => ({ path, line: n, text });

test("toggling adds a sheet or a line, and the same one again removes it", () => {
  let l: Bookmark[] = [];
  l = toggleBookmark(l, sheet("a.gm"));
  l = toggleBookmark(l, line("a.gm", 3, "霧笛"));
  l = toggleBookmark(l, line("b.md", 1, "x"));
  assert.equal(l.length, 3);
  l = toggleBookmark(l, line("a.gm", 3, "changed text"));
  assert.deepEqual(l, [sheet("a.gm"), line("b.md", 1, "x")]);
  l = toggleBookmark(l, sheet("a.gm"));
  assert.deepEqual(l, [line("b.md", 1, "x")]);
});

test("reordering and removing", () => {
  const l = [sheet("a"), sheet("b"), sheet("c")];
  assert.deepEqual(moveBookmark(l, 0, 2).map((b) => b.path), ["b", "c", "a"]);
  assert.deepEqual(moveBookmark(l, 2, 0).map((b) => b.path), ["c", "a", "b"]);
  assert.deepEqual(removeBookmark(l, 1).map((b) => b.path), ["a", "c"]);
});

test("the file reads back as written; malformed items are skipped; no file is an empty list", () => {
  const l = [sheet("chapters/01.gm"), line("notes/a.md", 4, "人物")];
  assert.deepEqual(parseBookmarks(writeBookmarks(l)), l);
  assert.deepEqual(parseBookmarks(`{"bookmarks":[{"path":"a"},{"path":3},{"line":2},{"path":"b","line":0,"text":"x"},{"path":"c","line":2}]}`), [sheet("a")]);
  assert.deepEqual(parseBookmarks(""), []);
  assert.deepEqual(parseBookmarks("not json"), []);
});

test("finding the line again: the same text at the kept number, else the nearest same text, else the number", () => {
  const lines = ["序", "", "霧笛が鳴る。", "灯台", "霧笛が鳴る。", "終"];
  assert.equal(relocate(lines, 3, "霧笛が鳴る。"), 3);
  assert.equal(relocate(lines, 4, "霧笛が鳴る。"), 3); // equal distance: the one before
  assert.equal(relocate(lines, 6, "霧笛が鳴る。"), 5);
  assert.equal(relocate(lines, 2, "灯台"), 4);
  assert.equal(relocate(lines, 2, "どこにもない"), 2);
  assert.equal(relocate(lines, 99, "どこにもない"), 6);
});

test("renaming a file or a folder moves the bookmarks under it", () => {
  const l = [sheet("ch/01.gm"), line("ch/02.gm", 2, "x"), sheet("chapter.md"), sheet("notes/a.md")];
  assert.deepEqual(renameBookmarks(l, "ch/01.gm", "ch/one.gm").map((b) => b.path), ["ch/one.gm", "ch/02.gm", "chapter.md", "notes/a.md"]);
  assert.deepEqual(renameBookmarks(l, "ch", "chapters").map((b) => b.path), ["chapters/01.gm", "chapters/02.gm", "chapter.md", "notes/a.md"]);
});
