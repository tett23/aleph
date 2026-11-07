import { test } from "node:test";
import assert from "node:assert/strict";
import { RECENT_LIMIT, keepExisting, parseRecent, pushRecentSheets, renameRecent } from "./recent.ts";

test("opened sheets go first; one already there moves up; the list keeps 50", () => {
  let r: string[] = [];
  r = pushRecentSheets(r, ["/w/a.gm"]);
  r = pushRecentSheets(r, ["/w/b.gm"]);
  r = pushRecentSheets(r, ["/w/a.gm"]);
  assert.deepEqual(r, ["/w/a.gm", "/w/b.gm"]);
  for (let i = 0; i < 60; i++) r = pushRecentSheets(r, [`/w/${i}.md`]);
  assert.equal(r.length, RECENT_LIMIT);
  assert.equal(r[0], "/w/59.md");
});

test("chapters opened together all go in, the focused one first", () => {
  assert.deepEqual(pushRecentSheets(["/w/x.gm"], ["/w/02.gm", "/w/01.gm", "/w/03.gm"]), ["/w/02.gm", "/w/01.gm", "/w/03.gm", "/w/x.gm"]);
});

test("the kept value is a list per workspace; other shapes are dropped", () => {
  assert.deepEqual(parseRecent({ "/w": ["/w/a.gm", 3, "/w/b.md"], "/v": "x", "/u": [] }), { "/w": ["/w/a.gm", "/w/b.md"], "/u": [] });
  assert.deepEqual(parseRecent(null), {});
  assert.deepEqual(parseRecent([1, 2]), {});
  const kept = { "/w": ["/w/a.gm"] };
  assert.deepEqual(parseRecent(JSON.parse(JSON.stringify(kept))), kept);
});

test("a renamed file or folder takes its place in the list", () => {
  assert.deepEqual(renameRecent(["/w/ch/01.gm", "/w/chapter.md", "/w/ch/02.gm"], "/w/ch", "/w/chapters"), ["/w/chapters/01.gm", "/w/chapter.md", "/w/chapters/02.gm"]);
  assert.deepEqual(renameRecent(["/w/a.gm"], "/w/a.gm", "/w/b.gm"), ["/w/b.gm"]);
});

test("sheets that no longer exist drop out when the list is written again; workspaces stay apart (docs/adr/0026)", () => {
  assert.deepEqual(keepExisting(["/w/a.md", "/w/gone.md", "/w/b.md"], new Set(["/w/a.md", "/w/b.md"])), ["/w/a.md", "/w/b.md"]);
  const r = parseRecent({ "/w": ["/w/a.md"], "/v": ["/v/b.md"] });
  assert.deepEqual([r["/w"], r["/v"]], [["/w/a.md"], ["/v/b.md"]]);
});
