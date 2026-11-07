import { test } from "node:test";
import assert from "node:assert/strict";
import { lineOffset, mirrorHtml } from "./mirror.ts";

test("one block per line, numbered from 1, with the change marks", () => {
  const html = mirrorHtml("一\n\n<三>", new Map([[0, "add" as const], [2, "mod" as const]]));
  assert.equal(
    html,
    '<div class="vl" data-n="1" data-m="add">一</div><div class="vl" data-n="2">​</div><div class="vl" data-n="3" data-m="mod">&lt;三&gt;</div>',
  );
});

test("a line starting with a full-width space keeps it", () => {
  assert.match(mirrorHtml("　本文", new Map()), /data-n="1">　本文</);
});

test("line offsets", () => {
  assert.equal(lineOffset("ab\ncd\nef", 1), 0);
  assert.equal(lineOffset("ab\ncd\nef", 3), 6);
  assert.equal(lineOffset("ab", 0), 0);
});
