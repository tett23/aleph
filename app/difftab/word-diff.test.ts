import assert from "node:assert/strict";
import { test } from "node:test";
import { diffTextHtml, readStructuredDiff } from "./text.ts";
import type { GitDiffSpan } from "../git-ipc.ts";

const read = (previous: string, next: string) => {
  const split = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const removed = split(previous).map((text): GitDiffSpan => ({ kind: "removed", text }));
  const added = split(next).map((text): GitDiffSpan => ({ kind: "added", text }));
  const lines = [...removed, ...added];
  return readStructuredDiff({
    body: lines.length ? "lines" : "empty",
    hunks: lines.length ? [{ heading: "@@ -1 +1 @@", lines }] : [],
    added: added.length,
    removed: removed.length,
  }, 2000);
};

test("ADR 0105 I5: the one replaced Japanese code point is isolated", () => {
  const diff = read("𠮷と赤い猫です。\n", "𠮷と青い猫です。\n");
  assert.equal(diff.lines.length, 2);
  assert.deepEqual(diff.lines[1], {
    kind: "text",
    spans: [
      { kind: "same", text: "𠮷と" },
      { kind: "removed", text: "赤" },
      { kind: "added", text: "青" },
      { kind: "same", text: "い猫です。\n" },
    ],
  });
});

test("ADR 0105 I5: English changes have the same code-point granularity", () => {
  const diff = read("red cat\n", "bed cat\n");
  assert.match(diffTextHtml(diff.lines), /<del[^>]*>r<\/del><ins[^>]*>b<\/ins>ed cat/);
});

test("ADR 0105 I5: preserves exact combining points and emoji and escapes markup", () => {
  const before = "é👋🏻[-x-]{+x+}<em>&\n";
  const after = "è👋🏽[-x-]{+x+}<em>&\n";
  const diff = read(before, after);
  const line = diff.lines[1];
  assert.equal(line.kind, "text");
  for (const [excluded, source] of [["added", before], ["removed", after]]) {
    assert.equal(line.spans.filter((part) => part.kind !== excluded).map((part) => part.text).join(""), source);
  }
  assert.match(diffTextHtml(diff.lines), /\[-x-\]\{\+x\+\}&lt;em&gt;&amp;/);
});

for (const [old, next, side] of [
  ["猫\n", "猫", "after"],
  ["猫", "猫\n", "before"],
  ["猫", "犬", "both"],
] as const) {
  test(`ADR 0105 I5: identifies a missing final newline on ${side}`, () => {
    const diff = read(old, next);
    assert.deepEqual(diff.lines.at(-1), { kind: "no-newline", side });
    assert.deepEqual([diff.added, diff.removed], [1, 1]);
  });
}

test("ADR 0105 I5: blank inserted lines and changed whitespace are kept", () => {
  const diff = read("a b \n", "a\tb\n\n");
  assert.deepEqual(diff.lines.slice(1), [
    { kind: "text", spans: [
      { kind: "same", text: "a" }, { kind: "removed", text: " " },
      { kind: "added", text: "\t" }, { kind: "same", text: "b" },
      { kind: "removed", text: " " }, { kind: "same", text: "\n" },
    ] },
    { kind: "text", spans: [{ kind: "added", text: "\n" }] },
  ]);
  assert.deepEqual([diff.added, diff.removed], [2, 1]);
});

test("ADR 0088 I6: a tracked empty file without changes has no body", () => {
  assert.deepEqual(read("", ""), { body: "empty", lines: [], moreLines: 0, added: 0, removed: 0 });
});
