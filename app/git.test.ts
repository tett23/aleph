import { test } from "node:test";
import assert from "node:assert/strict";
import { autosaveMessage, parseStatus, shouldAutoCommit, ymd } from "./git.ts";

test("the local date as YYYY-MM-DD", () => {
  assert.equal(ymd(new Date(2026, 10, 7, 23, 59)), "2026-11-07");
  assert.equal(ymd(new Date(2026, 0, 2, 0, 0)), "2026-01-02");
  assert.equal(autosaveMessage(new Date(2026, 10, 8, 0, 1)), "Autosave 2026-11-08");
});

test("commit once a day, only with changes", () => {
  // just after the date changed
  assert.equal(shouldAutoCommit({ today: "2026-11-08", last: "2026-11-07", changed: true, enabled: true }), true);
  // the second check of the same day
  assert.equal(shouldAutoCommit({ today: "2026-11-08", last: "2026-11-08", changed: true, enabled: true }), false);
  // a day without changes
  assert.equal(shouldAutoCommit({ today: "2026-11-08", last: "2026-11-07", changed: false, enabled: true }), false);
  // never committed before
  assert.equal(shouldAutoCommit({ today: "2026-11-08", last: undefined, changed: true, enabled: true }), true);
  // turned off
  assert.equal(shouldAutoCommit({ today: "2026-11-08", last: undefined, changed: true, enabled: false }), false);
});

test("git status --porcelain=v1 -z: Japanese paths, untracked, renamed", () => {
  const z = " M 灯台守の冬/chapters/01.gm\0?? notes/新しい メモ.md\0R  b.gm\0a.gm\0 D gone.txt\0";
  assert.deepEqual(parseStatus(z), [
    { code: "M", path: "灯台守の冬/chapters/01.gm" },
    { code: "??", path: "notes/新しい メモ.md" },
    { code: "R", path: "b.gm", from: "a.gm" },
    { code: "D", path: "gone.txt" },
  ]);
  assert.deepEqual(parseStatus(""), []);
});
