import { test } from "node:test";
import assert from "node:assert/strict";
import { addChapter, manifestChapters } from "./manifest.ts";

test("one-line array", () => {
  const m = `chapters = ["chapters/01.gm", "chapters/02.gm"]\n\n[metadata]\ntitle = "x"\n`;
  assert.deepEqual(manifestChapters(m), ["chapters/01.gm", "chapters/02.gm"]);
  assert.equal(addChapter(m, "chapters/03.gm"), `chapters = ["chapters/01.gm", "chapters/02.gm", "chapters/03.gm"]\n\n[metadata]\ntitle = "x"\n`);
});

test("multi-line array keeps one item per line", () => {
  const m = `chapters = [\n  "chapters/01.gm",\n  "chapters/02.gm",\n]\n`;
  assert.equal(addChapter(m, "chapters/03.gm"), `chapters = [\n  "chapters/01.gm",\n  "chapters/02.gm",\n  "chapters/03.gm"\n]\n`);
  const noTrailing = `chapters = [\n  "a.gm",\n  "b.gm"\n]\n`;
  assert.equal(addChapter(noTrailing, "c.gm"), `chapters = [\n  "a.gm",\n  "b.gm",\n  "c.gm"\n]\n`);
  assert.deepEqual(manifestChapters(addChapter(m, "chapters/03.gm")), ["chapters/01.gm", "chapters/02.gm", "chapters/03.gm"]);
});

test("empty array", () => {
  assert.deepEqual(manifestChapters(`chapters = []\n`), []);
  assert.equal(addChapter(`chapters = []\n`, "a.gm"), `chapters = ["a.gm"]\n`);
});

test("inline tables give their file", () => {
  const m = `chapters = [\n  "chapters/01.gm",\n  { file = "chapters/02-en.gm", paragraph-separator = "blank-line" },\n]\n`;
  assert.deepEqual(manifestChapters(m), ["chapters/01.gm", "chapters/02-en.gm"]);
  assert.deepEqual(manifestChapters(addChapter(m, "c.gm")), ["chapters/01.gm", "chapters/02-en.gm", "c.gm"]);
});

test("nested arrays give each of their files, in order", () => {
  const m = `chapters = ["a.gm", ["b1.gm", "b2.gm"], "c.gm"]\n`;
  assert.deepEqual(manifestChapters(m), ["a.gm", "b1.gm", "b2.gm", "c.gm"]);
  assert.deepEqual(manifestChapters(addChapter(m, "d.gm")), ["a.gm", "b1.gm", "b2.gm", "c.gm", "d.gm"]);
});

test("brackets and quotes inside strings and comments do not confuse it", () => {
  const m = `# chapters = ["x.gm"]\nchapters = ["a]b.gm", # a comment ]\n  "c.gm"]\n[source]\nparagraph-separator = "line"\n`;
  assert.deepEqual(manifestChapters(m), ["a]b.gm", "c.gm"]);
});

test("no chapters key adds one at the top", () => {
  assert.equal(addChapter(`[metadata]\n`, "a.gm"), `chapters = ["a.gm"]\n[metadata]\n`);
  assert.deepEqual(manifestChapters(`[metadata]\n`), []);
});

test("a path with a quote is escaped", () => {
  assert.equal(addChapter(`chapters = []`, `a"b.gm`), `chapters = ["a\\"b.gm"]`);
});
