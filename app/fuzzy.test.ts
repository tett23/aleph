import { test } from "node:test";
import assert from "node:assert/strict";
import { fuzzy } from "./fuzzy.ts";

test("a subsequence matches, case ignored; otherwise null", () => {
  assert.deepEqual(fuzzy("gc", "git.commit")?.positions, [0, 4]);
  assert.deepEqual(fuzzy("GC", "git.commit")?.positions, [0, 4]);
  assert.equal(fuzzy("xz", "git.commit"), null);
  assert.equal(fuzzy("", "anything")?.score, 0);
});

test("consecutive letters, word starts and the file name score higher", () => {
  const s = (q: string, t: string) => fuzzy(q, t)!.score;
  assert.ok(s("com", "commit") > s("com", "c-o-m"));
  assert.ok(s("gc", "git commit") > s("gc", "agcx"));
  assert.ok(s("note", "chapters/note.md") > s("note", "notes-dir/x.md"));
  assert.ok(s("ab", "a_b") > s("ab", "axb"));
});

test("Japanese and surrogate pairs keep their UTF-16 positions", () => {
  assert.deepEqual(fuzzy("霧笛", "霧笛")?.positions, [0, 1]);
  assert.deepEqual(fuzzy("霧笛", "霧の笛")?.positions, [0, 2]);
  assert.ok(fuzzy("霧笛", "霧笛")!.score > fuzzy("霧笛", "霧の笛")!.score);
  assert.deepEqual(fuzzy("𠮷田", "𠮷野の田")?.positions, [0, 4]);
});
