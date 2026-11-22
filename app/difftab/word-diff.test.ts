import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { diffTextHtml, fetchDiff } from "./text.ts";
import { diffArgs, readDiff } from "./read.ts";

const path = "draft[1].gm";
const plainArgs = () => diffArgs({ xy: " M", path }, true)!;

const setup = (t: TestContext, old: string, next: string) => {
  const cwd = mkdtempSync(join(tmpdir(), "aleph-word-diff-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, LC_ALL: "C.UTF-8", LANGUAGE: "C", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  git("init", "-q");
  writeFileSync(join(cwd, path), old);
  writeFileSync(join(cwd, "draft1.gm"), "separate file\n");
  writeFileSync(join(cwd, ".gitattributes"), "*.gm diff=whole\n");
  git("config", "diff.whole.wordRegex", ".+");
  git("config", "diff.wordRegex", ".+");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", "Original");
  writeFileSync(join(cwd, path), next);
  writeFileSync(join(cwd, "draft1.gm"), "changed separate file\n");
  return git;
};

const read = async (t: TestContext, previous: string, next: string) => {
  const git = setup(t, previous, next);
  const output = await fetchDiff(async (args) => ({ code: 0, stdout: git(...args) }), plainArgs());
  assert.ok(output);
  return readDiff(output.ordinary, output.porcelain);
};

test("ADR 0096 I1: Git's porcelain isolates the one replaced Japanese code point with a literal path and an explicit regex", async (t) => {
  const diff = await read(t, "𠮷と赤い猫です。\n", "𠮷と青い猫です。\n");
  assert.equal(diff.lines.length, 2, "the changed file matching the bracket pattern is excluded");
  assert.deepEqual(diff.lines[1], {
    kind: "text",
    spans: [
      { kind: "same", text: "𠮷と" },
      { kind: "removed", text: "赤" },
      { kind: "added", text: "青" },
      { kind: "same", text: "い猫です。" },
    ],
  });
});

test("ADR 0096 I1: English changes have the same code-point granularity", async (t) => {
  const diff = await read(t, "red cat\n", "bed cat\n");
  assert.match(diffTextHtml(diff.lines), /<del[^>]*>r<\/del><ins[^>]*>b<\/ins>ed cat/);
});

test("ADR 0096 I1, I2: combining points and emoji are kept without normalization and markup is escaped", async (t) => {
  const diff = await read(t, "é👋🏻[-x-]{+x+}<em>&\n", "è👋🏽[-x-]{+x+}<em>&\n");
  const span = diff.lines[1];
  assert.equal(span.kind, "text");
  for (const [excluded, source] of [
    ["added", "é👋🏻[-x-]{+x+}<em>&"],
    ["removed", "è👋🏽[-x-]{+x+}<em>&"],
  ]) {
    assert.equal(span.spans.filter((part) => part.kind !== excluded).map((part) => part.text).join(""), source);
  }
  assert.match(diffTextHtml(diff.lines), /\[-x-\]\{\+x\+\}&lt;em&gt;&amp;/);
});

for (const [old, next, side] of [
  ["猫\n", "猫", "after"],
  ["猫", "猫\n", "before"],
  ["猫", "犬", "both"],
] as const) {
  test(`ADR 0096 I1, I3: ordinary Git diff identifies a missing final newline on ${side}`, async (t) => {
    const diff = await read(t, old, next);
    assert.deepEqual(diff.lines.at(-1), { kind: "no-newline", side });
    assert.deepEqual([diff.added, diff.removed], [1, 1]);
  });
}

test("ADR 0096 I1, I3: blank inserted lines and changed whitespace are kept", async (t) => {
  const diff = await read(t, "a b \n", "a\tb\n\n");
  assert.deepEqual(diff.lines.slice(1), [
    { kind: "text", spans: [
      { kind: "same", text: "a" }, { kind: "removed", text: " " },
      { kind: "added", text: "\t" }, { kind: "same", text: "b" },
      { kind: "removed", text: " " },
    ] },
    { kind: "text", spans: [] },
  ]);
  assert.deepEqual([diff.added, diff.removed], [2, 1]);
});

test("ADR 0096 I1, I3: a tracked empty file without changes has no body", async (t) => {
  const diff = await read(t, "", "");
  assert.deepEqual(diff, { body: "empty", lines: [], moreLines: 0, added: 0, removed: 0 });
});

for (const [count, more] of [[1999, 0], [2000, 1]]) {
  test(`ADR 0096 I4: ${count + 1} restored lines include the hunk heading`, async (t) => {
    const diff = await read(t, "", "new\n".repeat(count));
    assert.equal(diff.lines.length, 2000);
    assert.equal(diff.moreLines, more);
    assert.deepEqual([diff.added, diff.removed], [count, 0]);
  });
}
