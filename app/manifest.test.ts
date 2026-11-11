import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { addChapter, manifestChapters, removeChapters, restoreChapters } from "./manifest.ts";

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

test("the paragraph separator of a file: @manifest, then the chapter's item, then [source], then blank-line", async () => {
  const { paragraphSeparator } = await import("./manifest.ts");
  const m = `chapters = [\n  "chapters/01.gm",\n  { file = "chapters/02.gm", paragraph-separator = "blank-line" },\n]\n\n[source]\nparagraph-separator = "line"\n`;
  assert.equal(paragraphSeparator(m, "chapters/01.gm", "本文"), "line");
  assert.equal(paragraphSeparator(m, "chapters/02.gm", "本文"), "blank-line");
  assert.equal(paragraphSeparator(m, "chapters/01.gm", "@manifest paragraph-separator=blank-line\n本文"), "blank-line");
  assert.equal(paragraphSeparator(`chapters = ["a.gm"]\n`, "a.gm", ""), "blank-line");
  assert.equal(paragraphSeparator(`chapters = ["a.gm"]\n[other]\nparagraph-separator = "line"\n`, "a.gm", ""), "blank-line");
});

// ---- removing chapters for the trash and putting them back (docs/adr/0033) ----

test("a chapter is taken out of a one-line array and put back where it was", () => {
  const src = 'chapters = ["a.gm", "b.gm", "c.gm"]\n';
  const r = removeChapters(src, ["b.gm"]);
  assert.equal(r.src, 'chapters = ["a.gm", "c.gm"]\n');
  assert.deepEqual(r.removed, [{ index: [1], text: '"b.gm"' }]);
  assert.equal(restoreChapters(r.src, r.removed), src);
  // the last one, and the only one
  assert.equal(removeChapters(src, ["c.gm"]).src, 'chapters = ["a.gm", "b.gm"]\n');
  assert.equal(removeChapters('chapters = ["a.gm"]\n', ["a.gm"]).src, "chapters = []\n");
  assert.equal(restoreChapters("chapters = []\n", [{ index: [0], text: '"a.gm"' }]), 'chapters = ["a.gm"]\n');
});

test("one item per line, with tables and a nested array", () => {
  const src = 'chapters = [\n  "a.gm",\n  { file = "b.gm", paragraph-separator = "line" },\n  ["c1.gm", "c2.gm"],\n  "d.gm",\n]\n';
  const r = removeChapters(src, ["b.gm", "c2.gm"]);
  assert.equal(r.src, 'chapters = [\n  "a.gm",\n  ["c1.gm"],\n  "d.gm",\n]\n');
  assert.equal(restoreChapters(r.src, r.removed), src);
  // a nested array left empty goes as a whole
  assert.equal(removeChapters(src, ["c1.gm", "c2.gm"]).src, 'chapters = [\n  "a.gm",\n  { file = "b.gm", paragraph-separator = "line" },\n  "d.gm",\n]\n');
});

test("put back at the end when the array got shorter; under a new name when renamed", () => {
  const removed = [{ index: [5], text: '"x.gm"' }];
  assert.equal(restoreChapters('chapters = ["a.gm"]\n', removed), 'chapters = ["a.gm", "x.gm"]\n');
  assert.equal(restoreChapters('chapters = ["a.gm"]\n', removed, { from: "x.gm", to: "x-2.gm" }), 'chapters = ["a.gm", "x-2.gm"]\n');
});

test("several chapters of one folder are taken out together and put back (docs/adr/0033)", () => {
  const src = 'chapters = ["part1/a.gm", "x.gm", "part1/b.gm"]\n';
  const r = removeChapters(src, ["part1/a.gm", "part1/b.gm"]);
  assert.equal(r.src, 'chapters = ["x.gm"]\n');
  assert.equal(restoreChapters(r.src, r.removed), src);
});

test("ADR 0066 invariant 1: chapter toggle removes duplicate nested references without changing neighbours", () => {
  const src = 'chapters = [\n  "a.gm",\n  ["x.gm", { file = "x.gm", paragraph-separator = "line" }],\n  { file = "b.gm", paragraph-separator = "line" },\n]\n';
  const removed = removeChapters(src, ["x.gm"]).src;
  assert.deepEqual(manifestChapters(removed), ["a.gm", "b.gm"]);
  assert.match(removed, /\{ file = "b.gm", paragraph-separator = "line" \}/);
  assert.deepEqual(manifestChapters(addChapter(removed, "x.gm")), ["a.gm", "b.gm", "x.gm"]);
});

test("ADR 0066 invariant 1: removing a sibling on the same line preserves the other chapter", () => {
  const source = 'chapters = [\n  "a.gm", "b.gm", # both on the same line\n  { file = "c.gm", paragraph-separator = "line" },\n]\n';
  const removed = removeChapters(source, ["a.gm"]).src;
  assert.deepEqual(manifestChapters(removed), ["b.gm", "c.gm"]);
  assert.match(removed, /paragraph-separator = "line"/);
});

test("ADR 0066 invariant 1: adding after a commented item keeps valid comma placement", () => {
  const source = 'chapters = [\n  "a.gm" # keep this comment\n]\n';
  const added = addChapter(source, "b.gm");
  assert.match(added, /"a.gm", # keep this comment/);
  assert.deepEqual(manifestChapters(added), ["a.gm", "b.gm"]);
});

test("ADR 0066 invariant 1: a multiline array closing on the last item line stays valid", () => {
  const source = 'chapters = [\n  "a.gm"]\n';
  const added = addChapter(source, "b.gm");
  assert.deepEqual(manifestChapters(added), ["a.gm", "b.gm"]);
  assert.match(added, /"b.gm"\]/);
});


test("ADR 0066 invariant 1: a temporary project keeps gm contents and the adjacent chapter", () => {
  const dir = mkdtempSync(join(tmpdir(), "aleph-0066-"));
  try {
    const gm = join(dir, "chapter.gm");
    const manifest = join(dir, "manifest.toml");
    writeFileSync(gm, "# Original\n");
    writeFileSync(manifest, 'chapters = ["chapter.gm", { file = "other.gm", paragraph-separator = "line" }]\n');
    writeFileSync(manifest, removeChapters(readFileSync(manifest, "utf8"), ["chapter.gm"]).src);
    assert.deepEqual(manifestChapters(readFileSync(manifest, "utf8")), ["other.gm"]);
    assert.match(readFileSync(manifest, "utf8"), /paragraph-separator = "line"/);
    assert.equal(readFileSync(gm, "utf8"), "# Original\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ADR 0066 invariant 1: deleting the only item with a trailing comma leaves an empty array", () => {
  const removed = removeChapters('chapters = ["a.gm",]\n', ["a.gm"]).src;
  assert.equal(removed, "chapters = []\n");
  assert.equal(addChapter(removed, "a.gm"), 'chapters = ["a.gm"]\n');
});

test("ADR 0066 invariant 1: adding to an empty multiline array keeps its lines", () => {
  const source = "chapters = [\n]\n";
  assert.equal(addChapter(source, "a.gm"), 'chapters = [\n  "a.gm"\n]\n');
});
