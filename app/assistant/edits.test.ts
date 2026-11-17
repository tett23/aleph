import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEdits, applyToSheet, occurrences } from "./edits.ts";

const fail = (r: ReturnType<typeof applyEdits>) => {
  assert.equal(r.ok, false);
  return r.ok ? "" : r.reason;
};

test("ADR 0081 I1: a find that appears exactly once applies", () => {
  const r = applyEdits('line-pitch = "18H"\nlines = 16\n', [{ find: 'line-pitch = "18H"', replace: 'line-pitch = "20H"' }]);
  assert.deepEqual(r, { ok: true, text: 'line-pitch = "20H"\nlines = 16\n' });
});

test("ADR 0081 I1: a find that is not in the target does not apply, with the reason", () => {
  assert.match(fail(applyEdits("abc", [{ find: "x", replace: "y" }])), /見つかりません/);
});

test("ADR 0081 I1: a find that appears twice does not apply, with the reason", () => {
  assert.match(fail(applyEdits("a = 1\na = 1\n", [{ find: "a = 1", replace: "a = 2" }])), /2 か所/);
});

test("ADR 0081 I1: occurrences that overlap each other count as two", () => {
  assert.equal(occurrences("aaa", "aa").length, 2);
  assert.match(fail(applyEdits("aaa", [{ find: "aa", replace: "b" }])), /2 か所/);
});

test("ADR 0081 I1: an empty find does not apply", () => {
  assert.match(fail(applyEdits("abc", [{ find: "", replace: "x" }])), /空/);
});

test("ADR 0081 I2: no edits change nothing", () => {
  assert.deepEqual(applyEdits("abc\n", []), { ok: true, text: "abc\n" });
});

test("ADR 0081 I1: two finds that each appear once but overlap do not apply", () => {
  const r = applyEdits("abcdef", [
    { find: "abcd", replace: "X" },
    { find: "cdef", replace: "Y" },
  ]);
  assert.match(fail(r), /重な/);
});

test("ADR 0081 I1: a find inside another find's range overlaps too", () => {
  assert.match(fail(applyEdits("abcdef", [{ find: "abcdef", replace: "X" }, { find: "cd", replace: "Y" }])), /重な/);
});

test("ADR 0081 I1, I2: two finds that each appear once and touch apply, and both places change", () => {
  const r = applyEdits("abcdef", [
    { find: "def", replace: "Y" },
    { find: "abc", replace: "X" },
  ]);
  assert.deepEqual(r, { ok: true, text: "XY" });
});

test("ADR 0081 I2: finds are placed in the text before any edit, not after the previous one", () => {
  // the first replace makes a second "b", which the second find must not see
  const r = applyEdits("a b c", [
    { find: "a", replace: "b" },
    { find: "b", replace: "B" },
  ]);
  assert.deepEqual(r, { ok: true, text: "b B c" });
});

test("ADR 0081 I2: the characters outside the finds do not change", () => {
  const text = "前\n[ruby: x|y]\n東京へ\n後\n";
  const r = applyEdits(text, [{ find: "東京", replace: "[ruby: 東京|とうきょう]" }]);
  assert.deepEqual(r, { ok: true, text: "前\n[ruby: x|y]\n[ruby: 東京|とうきょう]へ\n後\n" });
});

test("ADR 0081 I1: an edit missing find or replace is refused", () => {
  assert.match(fail(applyEdits("abc", [{ find: "a" } as never])), /形/);
});

test("ADR 0081 I1: on the whole sheet, a change made after the request is counted again in the current text", () => {
  // asked on "a = 1\nb = 2\n"; the writer added a line since
  const now = "a = 1\nb = 2\nc = 3\n";
  assert.deepEqual(applyToSheet(now, { kind: "sheet" }, [{ find: "b = 2", replace: "b = 5" }]), { ok: true, text: "a = 1\nb = 5\nc = 3\n" });
});

test("ADR 0081 I1: the writer rewrote outside the selection after the request; the edit is counted again and applies", () => {
  const selection = "東京へ行く。";
  const now = "まえがき。\n東京へ行く。\n東京は遠い。\n";
  assert.deepEqual(applyToSheet(now, { kind: "selection", text: selection }, [{ find: "東京", replace: "[ruby: 東京|とうきょう]" }]), {
    ok: true,
    text: "まえがき。\n[ruby: 東京|とうきょう]へ行く。\n東京は遠い。\n",
  });
});

test("ADR 0081 I1: the writer rewrote inside the selection after the request; the edit does not apply, with the reason", () => {
  const r = applyToSheet("東京に行く。\n", { kind: "selection", text: "東京へ行く。" }, [{ find: "東京", replace: "X" }]);
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.reason, /選択/);
});

test("ADR 0081 I1: a selection whose text now appears twice in the sheet does not apply", () => {
  const r = applyToSheet("abc\nabc\n", { kind: "selection", text: "abc" }, [{ find: "b", replace: "X" }]);
  assert.equal(r.ok, false);
});
