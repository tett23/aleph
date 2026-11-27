import { test } from "node:test";
import assert from "node:assert/strict";
import { errorFrameHtml } from "./error-frame.ts";

test("ADR 0115 I1: preview errors are selectable in a scriptless opaque frame", () => {
  const html = errorFrameHtml("エラー <script>alert(1)</script> & 詳細");
  assert.match(html, /user-select: text/);
  assert.match(html, /script-src 'none'/);
  assert.match(html, /エラー &lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; 詳細/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(errorFrameHtml("x", "#abcdef"), /color:#abcdef/);
  assert.match(errorFrameHtml("x", "red; background:url(evil)"), /color:#d25544/);
});
