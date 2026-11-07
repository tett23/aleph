import { test } from "node:test";
import assert from "node:assert/strict";
import { argPath, underRoot, within, basename, dirname, ext, rel, stem } from "./path.ts";

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

test("underRoot: a path that stays under its root, normalized; climbing out, absolute and ~ are refused (docs/adr/0048)", () => {
  assert.equal(underRoot("/w", "a/b.md"), "a/b.md");
  assert.equal(underRoot("/w", "./a/./b.md"), "a/b.md");
  assert.equal(underRoot("/w", "a/../b.md"), "b.md");
  assert.equal(underRoot("/w", "a//b.md"), "a/b.md");
  for (const bad of ["../x.md", "../../../etc/passwd", "../w/a.md", "a/../../w/a.md", "/etc/passwd", "~/x.md", "~", "", ".", "a/.."]) {
    assert.equal(underRoot("/w", bad), null, bad);
  }
});

test("argPath: a relative path never reads as an option (docs/adr/0048)", () => {
  assert.equal(argPath("-x.gm"), "./-x.gm");
  assert.equal(argPath("chapters/01.gm"), "./chapters/01.gm");
  assert.equal(argPath("/w/p/a.pdf"), "/w/p/a.pdf");
});

test("within: a path read from a folder, kept under the root", () => {
  assert.equal(within("/w", "/w/notes", "img/a.png"), "/w/notes/img/a.png");
  assert.equal(within("/w", "/w/notes", "../img/a.png"), "/w/img/a.png");
  assert.equal(within("/w", "/w", "a.png"), "/w/a.png");
  assert.equal(within("/w", "/w/notes", "../../a.png"), null);
  assert.equal(within("/w", "/w/notes", "/w/a.png"), null);
  assert.equal(within("/w", "/x", "a.png"), null);
});
