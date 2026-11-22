import { test } from "node:test";
import assert from "node:assert/strict";
import { autosaveMessage, shouldAutoCommit, ymd } from "./git.ts";

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
