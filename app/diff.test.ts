import { test } from "node:test";
import assert from "node:assert/strict";
import { lineMarks } from "./diff.ts";

const marks = (base: string | null, now: string) => Object.fromEntries(lineMarks(base, now));

test("no change, no marks", () => {
  assert.deepEqual(marks("a\nb\n", "a\nb\n"), {});
});

test("a file not in HEAD is all added", () => {
  assert.deepEqual(marks(null, "a\nb"), { 0: "add", 1: "add" });
});

test("added lines", () => {
  assert.deepEqual(marks("a\nc", "a\nb\nc"), { 1: "add" });
  assert.deepEqual(marks("a", "a\nb\nc"), { 1: "add", 2: "add" });
});

test("a changed line is modified", () => {
  assert.deepEqual(marks("a\nb\nc", "a\nB\nc"), { 1: "mod" });
});

test("more lines than were removed: the first are modified, the rest added", () => {
  assert.deepEqual(marks("a\nb\nc", "a\nB1\nB2\nc"), { 1: "mod", 2: "add" });
});

test("a deletion marks the line after it", () => {
  assert.deepEqual(marks("a\nb\nc", "a\nc"), { 1: "del" });
});

test("deleting everything", () => {
  assert.deepEqual(marks("a\nb", ""), { 0: "mod" });
});

test("common head and tail are not marked", () => {
  const base = Array.from({ length: 200 }, (_, i) => `l${i}`).join("\n");
  const now = base.replace("l100", "changed");
  assert.deepEqual(marks(base, now), { 100: "mod" });
});

test("a huge change gives up and marks the changed middle as modified", () => {
  const a = Array.from({ length: 3000 }, (_, i) => `a${i}`).join("\n");
  const b = Array.from({ length: 3000 }, (_, i) => `b${i}`).join("\n");
  const m = lineMarks(a, b);
  assert.equal(m.size, 3000);
  assert.equal(m.get(0), "mod");
});

test("an empty base: the first line is modified, the rest added", () => {
  assert.deepEqual(marks("", "a\nb"), { 0: "mod", 1: "add" });
});
