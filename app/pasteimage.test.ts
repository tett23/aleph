import { test } from "node:test";
import assert from "node:assert/strict";
import { mdImageInsert, pasteKind, pastedName, pastePlace, toPng } from "./pasteimage.ts";
import { freeName } from "./library.ts";

test("what a paste is: text wins; images only without text; otherwise nothing", () => {
  assert.equal(pasteKind("文", []), "text");
  assert.equal(pasteKind("", ["image/png"]), "image");
  assert.equal(pasteKind("文と画像", ["image/png"]), "text");
  assert.equal(pasteKind("", ["application/pdf"]), "none");
  assert.equal(pasteKind("", []), "none");
});

test("names from the time, zero-padded; .jpg for JPEG, .png for the rest", () => {
  const d = new Date(2026, 0, 2, 3, 4, 5);
  assert.equal(pastedName(d, "image/png"), "pasted-20260102-030405.png");
  assert.equal(pastedName(d, "image/jpeg"), "pasted-20260102-030405.jpg");
  assert.equal(pastedName(d, "image/tiff"), "pasted-20260102-030405.png");
  assert.deepEqual(["image/png", "image/jpeg", "image/tiff", "image/gif", "image/webp"].map(toPng), [false, false, true, true, true]);
});

test("several images at once do not share a name", async () => {
  const taken = new Set(["/p/images/pasted-20260102-030405.png"]);
  const fs = { exists: async (p: string) => taken.has(p) };
  const a = await freeName(fs as never, "/p/images", "pasted-20260102-030405.png");
  taken.add(`/p/images/${a}`);
  const b = await freeName(fs as never, "/p/images", "pasted-20260102-030405.png");
  assert.deepEqual([a, b], ["pasted-20260102-030405-2.png", "pasted-20260102-030405-3.png"]);
});

test("where the images go: a project's images/ for its .gm, the sheet's folder's images/ for .md; none for .gm outside projects", () => {
  const projects = ["/w/p"];
  assert.deepEqual(pastePlace("/w/p/chapters/01.gm", "gm", projects), { dir: "/w/p/images", ref: "images" });
  assert.equal(pastePlace("/w/notes/a.gm", "gm", projects), null);
  assert.deepEqual(pastePlace("/w/p/notes/a.md", "md", projects), { dir: "/w/p/notes/images", ref: "images" });
  assert.deepEqual(pastePlace("/w/a.md", "md", projects), { dir: "/w/images", ref: "images" });
  assert.equal(pastePlace("/w/a.txt", "txt", projects), null);
});

test("Markdown: image lines after the caret's line, with blank lines around", () => {
  assert.deepEqual(mdImageInsert("一\n二", 1, ["images/a.png"]), { at: 2, insert: "\n![a.png](images/a.png)\n\n" });
  assert.deepEqual(mdImageInsert("一\n\n二", 2, ["images/a.png"]), { at: 3, insert: "![a.png](images/a.png)\n\n" });
  assert.deepEqual(mdImageInsert("一", 1, ["images/a.png", "images/b.png"]), { at: 1, insert: "\n\n![a.png](images/a.png)\n\n![b.png](images/b.png)\n" });
});
