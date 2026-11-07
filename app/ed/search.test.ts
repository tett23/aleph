import { test } from "node:test";
import assert from "node:assert/strict";
import { findAll, nearest, replacementOf, selectionMatches } from "./search.ts";

test("plain search ignores case unless asked, and finds every occurrence", () => {
  assert.deepEqual(findAll("Abc abc ABC", { search: "abc" }), [
    { from: 0, to: 3 },
    { from: 4, to: 7 },
    { from: 8, to: 11 },
  ]);
  assert.deepEqual(findAll("Abc abc ABC", { search: "abc", caseSensitive: true }), [{ from: 4, to: 7 }]);
});

test("plain search treats regexp characters as text", () => {
  assert.deepEqual(findAll("a.b axb", { search: "a.b" }), [{ from: 0, to: 3 }]);
});

test("regexp search, with empty matches skipped", () => {
  assert.deepEqual(findAll("cat 12 dog 345", { search: "\\d+", regexp: true }), [
    { from: 4, to: 6 },
    { from: 11, to: 14 },
  ]);
  assert.deepEqual(findAll("abc", { search: "x*", regexp: true }), []);
});

test("a broken regexp finds nothing instead of throwing", () => {
  assert.deepEqual(findAll("abc", { search: "(", regexp: true }), []);
});

test("an empty search finds nothing", () => {
  assert.deepEqual(findAll("abc", { search: "" }), []);
});

test("Japanese and surrogate pairs keep their offsets", () => {
  assert.deepEqual(findAll("𠮷野家の𠮷", { search: "𠮷" }), [
    { from: 0, to: 2 },
    { from: 5, to: 7 },
  ]);
});

test("the next match from the caret, wrapping around; and the previous one", () => {
  const m = [
    { from: 2, to: 3 },
    { from: 6, to: 7 },
  ];
  assert.deepEqual(nearest(m, 0, 1), { from: 2, to: 3 });
  assert.deepEqual(nearest(m, 3, 1), { from: 6, to: 7 });
  assert.deepEqual(nearest(m, 7, 1), { from: 2, to: 3 });
  assert.deepEqual(nearest(m, 6, -1), { from: 2, to: 3 });
  assert.deepEqual(nearest(m, 2, -1), { from: 6, to: 7 });
  assert.equal(nearest([], 0, 1), null);
});

test("a regexp replacement fills in groups; a plain one is taken as it is", () => {
  assert.equal(replacementOf("2026-11", { search: "(\\d+)-(\\d+)", regexp: true }, "$2/$1"), "11/2026");
  assert.equal(replacementOf("abc", { search: "abc" }, "$1"), "$1");
});

test("other occurrences of a short selection are marked; long, multi-line or blank selections are not", () => {
  assert.deepEqual(selectionMatches("霧笛と霧笛と霧", { from: 0, to: 2 }), [{ from: 3, to: 5 }]);
  assert.deepEqual(selectionMatches("abcabc", { from: 0, to: 0 }), []);
  assert.deepEqual(selectionMatches("a\nba\nb", { from: 0, to: 3 }), []);
  assert.deepEqual(selectionMatches("  x  ", { from: 0, to: 2 }), []);
  assert.deepEqual(selectionMatches("x".repeat(402), { from: 0, to: 201 }), []);
  // case matters
  assert.deepEqual(selectionMatches("Ab ab", { from: 3, to: 5 }), []);
});
