import { test } from "node:test";
import assert from "node:assert/strict";
import { defaults, isDark, normalize } from "./config.ts";

test("an empty or broken config gives the defaults", () => {
  assert.deepEqual(normalize({}), defaults());
  assert.deepEqual(normalize(null), defaults());
  assert.deepEqual(normalize("x"), defaults());
});

test("numbers out of range are clamped to the bounds", () => {
  const c = normalize({ fontSize: 1620, codeFontSize: 1, lineHeight: 9, autosaveSeconds: 0, dpi: 5000 });
  assert.equal(c.fontSize, 32);
  assert.equal(c.codeFontSize, 9);
  assert.equal(c.lineHeight, 3);
  assert.equal(c.autosaveSeconds, 2);
  assert.equal(c.dpi, 1200);
});

test("wrong types fall back to the defaults", () => {
  const c = normalize({ fontSize: "20", theme: "blue", showInvisibles: "yes", workspaces: "x" });
  assert.equal(c.fontSize, 16);
  assert.equal(c.theme, "auto");
  assert.equal(c.showInvisibles, false);
  assert.deepEqual(c.workspaces, []);
});

test("dpi 0 means automatic and is kept", () => {
  assert.equal(normalize({ dpi: 0 }).dpi, 0);
  assert.equal(normalize({ dpi: 150 }).dpi, 150);
});

test("characters per line: null keeps style.toml's value", () => {
  assert.equal(normalize({ charsOverride: null }).charsOverride, null);
  assert.equal(normalize({ charsOverride: 1000 }).charsOverride, 200);
});

test("workspaces drop duplicates and empty strings", () => {
  assert.deepEqual(normalize({ workspaces: ["/a", "", "/a", 3, "/b"] }).workspaces, ["/a", "/b"]);
});

test("the last auto commit keeps only string dates", () => {
  assert.deepEqual(normalize({ lastAutoCommit: { "/a": "2026-11-07", "/b": 3 } }).lastAutoCommit, { "/a": "2026-11-07" });
});

test("dark applies by the theme, or by the system in auto", () => {
  assert.equal(isDark("dark", false), true);
  assert.equal(isDark("light", true), false);
  assert.equal(isDark("auto", true), true);
  assert.equal(isDark("auto", false), false);
});

test("the kept screen state: an object is kept as it is, anything else is empty", () => {
  const ui = { left: "git", vertical: true, expanded: ["/w/a"], pageZoom: 1.5 };
  assert.deepEqual(normalize({ ui }).ui, ui);
  assert.deepEqual(normalize({ ui: "x" }).ui, {});
  assert.deepEqual(normalize({ ui: [1] }).ui, {});
  assert.deepEqual(normalize({}).ui, {});
});

test("the key settings: bindings kept as string lists, the leader key checked, the wait clamped (docs/adr/0034)", () => {
  const c = normalize({ keyBindings: { "git.commit": ["Leader g c", 3], bad: "Mod-s" }, leaderKey: "j", keySequenceTimeout: 50 });
  assert.deepEqual(c.keyBindings, { "git.commit": ["Leader g c"] });
  assert.equal(c.leaderKey, "Mod-;");
  assert.equal(c.keySequenceTimeout, 200);
  assert.equal(normalize({ keySequenceTimeout: 99999 }).keySequenceTimeout, 5000);
  assert.equal(normalize({ leaderKey: "Ctrl-j" }).leaderKey, "Ctrl-j");
  assert.deepEqual([defaults().keyBindings, defaults().leaderKey, defaults().keySequenceTimeout], [{}, "Mod-;", 1000]);
});
