import { test } from "node:test";
import assert from "node:assert/strict";
import { autosaveMessage, gitMissingHtml, gitWrites, parseStatus, shouldAutoCommit, ymd } from "./git.ts";

test("the local date as YYYY-MM-DD", () => {
  assert.equal(ymd(new Date(2026, 10, 7, 23, 59)), "2026-11-07");
  assert.equal(ymd(new Date(2026, 0, 2, 0, 0)), "2026-01-02");
  assert.equal(autosaveMessage(new Date(2026, 10, 8, 0, 1)), "Autosave 2026-11-08");
});

test("commit once a day, only with changes", () => {
  // just after the date changed
  assert.equal(shouldAutoCommit({ today: "2026-11-08", last: "2026-11-07", changed: true, enabled: true, git: true }), true);
  // the second check of the same day
  assert.equal(shouldAutoCommit({ today: "2026-11-08", last: "2026-11-08", changed: true, enabled: true, git: true }), false);
  // a day without changes
  assert.equal(shouldAutoCommit({ today: "2026-11-08", last: "2026-11-07", changed: false, enabled: true, git: true }), false);
  // never committed before
  assert.equal(shouldAutoCommit({ today: "2026-11-08", last: undefined, changed: true, enabled: true, git: true }), true);
  // turned off
  assert.equal(shouldAutoCommit({ today: "2026-11-08", last: undefined, changed: true, enabled: false, git: true }), false);
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

test("no daily commit when git cannot be used (docs/adr/0060)", () => {
  assert.equal(shouldAutoCommit({ today: "2026-11-08", last: "2026-11-07", changed: true, enabled: true, git: false }), false);
});

test("the Git panel when git cannot be used: the reason, how to install, and recheck, but no git init (docs/adr/0060)", () => {
  const html = gitMissingHtml("xcrun: error: invalid active developer path <x>");
  assert.match(html, /git が使えません/);
  assert.match(html, /xcrun: error: invalid active developer path &lt;x&gt;/);
  assert.match(html, /xcode-select --install/);
  assert.match(html, /Homebrew/);
  assert.match(html, /data-a="recheck"/);
  assert.match(html, /data-a="settings"/);
  assert.doesNotMatch(html, /data-a="init"/);
});

test("the git subcommands that write, which go one at a time per workspace (docs/adr/0062)", () => {
  for (const s of ["add", "commit", "init", "pull", "push"]) assert.equal(gitWrites([s, "x"]), true, s);
  for (const s of ["status", "diff", "log", "show", "rev-parse", "branch"]) assert.equal(gitWrites([s]), false, s);
  assert.equal(gitWrites([]), false);
});
