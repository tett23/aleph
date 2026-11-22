import assert from "node:assert/strict";
import { test } from "node:test";
import { characterSpans, readStructuredDiff } from "./text.ts";

test("ADR 0105 I5: preserves exact Unicode and newline and breaks ties by deleting first", () => {
  assert.deepEqual(characterSpans("𠮷ab\n", "𠮷ba"), [
    { kind: "same", text: "𠮷" }, { kind: "removed", text: "a" },
    { kind: "same", text: "b" }, { kind: "removed", text: "\n" },
    { kind: "added", text: "a" },
  ]);
});

test("ADR 0105 I5: finds interior matches above four million cells", () => {
  const before = "猫".repeat(1000) + "𠮷" + "猫".repeat(1000);
  const after = "犬".repeat(1000) + "𠮷" + "犬".repeat(1000);
  const spans = characterSpans(before, after);
  assert.deepEqual(spans.filter((s) => s.kind === "same"), [{ kind: "same", text: "𠮷" }]);
  assert.equal(spans.filter((s) => s.kind !== "added").map((s) => s.text).join(""), before);
  assert.equal(spans.filter((s) => s.kind !== "removed").map((s) => s.text).join(""), after);
});

test("ADR 0105 I5: keeps line counts and EOF information past the display limit", () => {
  const diff = {
    body: "lines", added: 1, removed: 1,
    hunks: [{ heading: "@@ -1 +1 @@", lines: [{ kind: "removed", text: "猫\n" }, { kind: "added", text: "猫" }] }],
  } as const;
  assert.deepEqual(readStructuredDiff(diff, 2), {
    body: "lines", added: 1, removed: 1, moreLines: 1,
    lines: [{ kind: "hunk", text: "@@ -1 +1 @@" }, { kind: "text", spans: [{ kind: "same", text: "猫" }, { kind: "removed", text: "\n" }] }],
  });
});
