import { test } from "node:test";
import assert from "node:assert/strict";
import { afterHtml, confirmText, projectsTouched, spotsOf } from "./replace.ts";

test("the line after the replacement: the match struck out, the new text strong, in characters", () => {
  assert.equal(afterHtml("𠮷は父<と>", 2, 3, "母"), "𠮷は<del>父</del><strong>母</strong>&lt;と&gt;");
});

test("the question before replacing: counts, and whether Git can undo", () => {
  assert.equal(confirmText(3, 12, false), "3 ファイルの 12 件を置換しますか。ディスクの上のファイルの置換は元に戻せません。");
  assert.equal(confirmText(1, 2, true), "1 ファイルの 2 件を置換しますか。Git の変更から戻せます。");
  assert.equal(confirmText(3, 2000, false, true), "3 ファイル以上の 2000 件以上を置換しますか。ディスクの上のファイルの置換は元に戻せません。");
});

test("the chosen matches by path", () => {
  const hits = [
    { path: "/a", line: 1, column: 0, matched: "父" },
    { path: "/a", line: 2, column: 3, matched: "父" },
    { path: "/b", line: 1, column: 1, matched: "父" },
  ];
  assert.deepEqual(spotsOf(hits, new Set([0, 2])), { "/a": [{ line: 1, column: 0, matched: "父" }], "/b": [{ line: 1, column: 1, matched: "父" }] });
});

test("the projects to check after replacing: once each, only for kinds lint reads, not outside projects (docs/adr/0041)", () => {
  const projects = ["/w/p", "/w/q", "/w/r"];
  assert.deepEqual(projectsTouched(["/w/p/a.gm", "/w/p/b.gm", "/w/q/notes.md", "/w/r/style.toml", "/w/x.gm"], projects), ["/w/p", "/w/r"]);
  assert.deepEqual(projectsTouched([], projects), []);
});
