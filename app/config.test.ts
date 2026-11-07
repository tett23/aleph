import { test } from "node:test";
import assert from "node:assert/strict";
import { adopt, defaults, isDark, normalize } from "./config.ts";

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

test("the writing checks: an old config without them gets the defaults; values are read rule by rule (docs/adr/0030)", () => {
  const d = normalize({});
  assert.equal(d.proofread.enabled, true);
  assert.equal(Object.values(d.proofread.rules).every(Boolean), true);
  const c = normalize({ proofread: { enabled: false, rules: { raNuki: false, bogus: true, spelling: "x" }, ignoreWords: ["Aleph", 3, " "] } });
  assert.equal(c.proofread.enabled, false);
  assert.equal(c.proofread.rules.raNuki, false);
  assert.equal(c.proofread.rules.spelling, true);
  assert.deepEqual(c.proofread.ignoreWords, ["Aleph"]);
});

test("Markdown line breaks: newline by default and for unknown values (docs/adr/0035)", () => {
  assert.equal(normalize({}).markdownBreaks, "newline");
  assert.equal(normalize({ markdownBreaks: "blank-line" }).markdownBreaks, "blank-line");
  assert.equal(normalize({ markdownBreaks: "x" }).markdownBreaks, "newline");
});

test("the settings Rust wrote replace only the paths it keeps (docs/adr/0050)", () => {
  const c = defaults();
  c.theme = "dark";
  c.workspaces = ["/w/a"];
  const written = JSON.stringify({ workspaces: ["/w/a", "/w/b"], libraryDir: "/lib", gitPath: "/g", golemPath: "/go", shemPath: "/s", theme: "light" });
  adopt(c, written);
  assert.deepEqual(c.workspaces, ["/w/a", "/w/b"]);
  assert.equal(c.libraryDir, "/lib");
  assert.equal(c.gitPath, "/g");
  assert.equal(c.golemPath, "/go");
  assert.equal(c.shemPath, "/s");
  assert.equal(c.theme, "dark", "the rest is the webview's");
});
