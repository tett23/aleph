import { test } from "node:test";
import assert from "node:assert/strict";
import { handedOver, outsideWindow, zipNames } from "./handover.ts";

const rows = ["/w/p", "/w/p/a.gm", "/w/p/b.pdf", "/w/p/build", "/w/p/build/x.pdf"];

test("ADR 0077 I6: a pressed row that is not selected is handed over alone", () => {
  assert.deepEqual(handedOver("/w/p/b.pdf", ["/w/p/a.gm", "/w/p/build/x.pdf"], rows), ["/w/p/b.pdf"]);
  assert.deepEqual(handedOver("/w/p/b.pdf", [], rows), ["/w/p/b.pdf"]);
});

test("ADR 0077 I6: a pressed row that is selected hands over every selected row in the tree's order", () => {
  assert.deepEqual(handedOver("/w/p/a.gm", ["/w/p/build/x.pdf", "/w/p/a.gm", "/w/p/b.pdf"], rows), ["/w/p/a.gm", "/w/p/b.pdf", "/w/p/build/x.pdf"]);
});

test("ADR 0077 I6: a selected path that has no row now is not handed over", () => {
  assert.deepEqual(handedOver("/w/p/a.gm", ["/w/q/c.gm", "/w/p/a.gm"], rows), ["/w/p/a.gm"]);
});

test("ADR 0077 I6: a drag leaves the window when the pointer is past any edge", () => {
  assert.equal(outsideWindow(10, 10, 800, 600), false);
  assert.equal(outsideWindow(0, 0, 800, 600), false);
  assert.equal(outsideWindow(-1, 10, 800, 600), true);
  assert.equal(outsideWindow(10, -1, 800, 600), true);
  assert.equal(outsideWindow(800, 10, 800, 600), true);
  assert.equal(outsideWindow(10, 600, 800, 600), true);
});

test("ADR 0077 I3: zip names are normalized to NFC and paired with the names on disk", () => {
  const nfd = "原稿/が.gm";
  assert.deepEqual(zipNames(["原稿/", nfd]), [
    ["原稿/", "原稿/"],
    [nfd, "原稿/が.gm"],
  ]);
});
