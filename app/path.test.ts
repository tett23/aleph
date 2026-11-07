import { test } from "node:test";
import assert from "node:assert/strict";
import { basename, dirname, ext, rel, stem } from "./path.ts";

test("path parts", () => {
  assert.equal(basename("/w/p/chapters/01.gm"), "01.gm");
  assert.equal(dirname("/w/p/chapters/01.gm"), "/w/p/chapters");
  assert.equal(ext("/w/p/a.GM"), "gm");
  assert.equal(ext("/w/p/.aleph"), "");
  assert.equal(ext("/w/p/README"), "");
  assert.equal(stem("/w/p/人物相関.mmd"), "人物相関");
  assert.equal(stem("/w/p/.gitignore"), ".gitignore");
});

test("relative paths stay whole outside the root", () => {
  assert.equal(rel("/w", "/w/p/a.gm"), "p/a.gm");
  assert.equal(rel("/w", "/wx/a.gm"), "/wx/a.gm");
  assert.equal(rel("/w", "/w"), "/w");
});

test("resolving a relative path against a directory", async () => {
  const { resolve } = await import("./path.ts");
  assert.equal(resolve("/w/p/build/html/chapters", "../images/a.png"), "/w/p/build/html/images/a.png");
  assert.equal(resolve("/w/p", "./a/./b.png"), "/w/p/a/b.png");
  assert.equal(resolve("/w/p", "/abs/x.png"), "/abs/x.png");
  assert.equal(resolve("/w", "../../x"), "/x");
});
