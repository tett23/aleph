import { test } from "node:test";
import assert from "node:assert/strict";
import { canVertical, effectiveSide, previewLabel, previewsFor } from "./toolbar.ts";

test("previews by kind", () => {
  assert.deepEqual(previewsFor("gm"), ["none", "plain", "pages"]);
  assert.deepEqual(previewsFor("md"), ["none", "plain"]);
  assert.deepEqual(previewsFor("mmd"), ["none", "plain"]);
  assert.deepEqual(previewsFor("toml"), []);
  assert.deepEqual(previewsFor("pdf"), []);
});

test("only prose can be vertical", () => {
  assert.equal(canVertical("gm"), true);
  assert.equal(canVertical("txt"), true);
  assert.equal(canVertical("toml"), false);
});

test("labels", () => {
  assert.equal(previewLabel("gm", "plain"), "本文");
  assert.equal(previewLabel("md", "plain"), "プレビュー");
  assert.equal(previewLabel("gm", "pages"), "ページ");
  assert.equal(previewLabel("gm", "none"), "原稿のみ");
});

test("a preview the kind lacks is not shown", () => {
  assert.equal(effectiveSide("md", "pages"), "none");
  assert.equal(effectiveSide("gm", "pages"), "pages");
  assert.equal(effectiveSide("toml", "plain"), "none");
});
