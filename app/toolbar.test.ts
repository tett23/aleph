import { test } from "node:test";
import assert from "node:assert/strict";
import { canVertical, previewLabel, previewsFor, verticalOn } from "./toolbar.ts";

test("previews by kind, without \"none\" (docs/adr/0087)", () => {
  assert.deepEqual(previewsFor("gm"), ["plain", "pages"]);
  assert.deepEqual(previewsFor("md"), ["plain"]);
  assert.deepEqual(previewsFor("svg"), ["plain"]);
  assert.deepEqual(previewsFor("mmd"), ["plain"]);
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
});

test("vertical holds for several sheets when all of them are prose (docs/adr/0019)", () => {
  const st = (vertical: boolean, kinds: string[]) => ({ vertical, open: kinds.map((kind) => ({ kind })) });
  assert.equal(verticalOn(st(true, ["gm", "gm", "gm"])), true);
  assert.equal(verticalOn(st(true, ["gm"])), true);
  assert.equal(verticalOn(st(true, ["gm", "toml"])), false);
  assert.equal(verticalOn(st(false, ["gm"])), false);
  assert.equal(verticalOn(st(true, [])), false);
});
