import { test } from "node:test";
import assert from "node:assert/strict";
import { normalize } from "./config.ts";
import { readKeyBindings, readUi } from "./legacy-names.ts";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Reads a config.json and writes it again, as the app does. */
const roundTrip = (raw: unknown) => JSON.parse(JSON.stringify(normalize(raw)));

test("ADR 0082 I5: an old ui key alone is written under its new name only", () => {
  assert.deepEqual(roundTrip({ ui: { showLeft: false } }).ui, { showSidebar: false });
});

test("ADR 0082 I5: every old ui key is read as its new one", () => {
  const ui = { left: "git", showLeft: false, right: "links", showRight: false, side: "pages", showProblems: true, problemsHeight: 240, problemsTab: "notes" };
  assert.deepEqual(readUi(ui), {
    sidebarPanel: "git",
    showSidebar: false,
    rightSidebarPanel: "links",
    showRightSidebar: false,
    previewMode: "pages",
    showBottomPanel: true,
    bottomPanelHeight: 240,
    bottomPanelTab: "notifications",
  });
});

test("ADR 0082 I5: with both the old and the new key, the new key's value stays", () => {
  assert.deepEqual(roundTrip({ ui: { showLeft: false, showSidebar: true } }).ui, { showSidebar: true });
});

test("ADR 0082 I5: an empty ui stays empty, without old names", () => {
  assert.deepEqual(roundTrip({ ui: {} }).ui, {});
  assert.deepEqual(roundTrip({}).ui, {});
});

test("ADR 0082 I5: keys that were not renamed are kept as they are", () => {
  assert.deepEqual(readUi({ pageZoom: 2, vertical: true, expanded: ["/w/a"] }), { pageZoom: 2, vertical: true, expanded: ["/w/a"] });
});

test("ADR 0082 I5: the old bottom panel tab values are read as the new ones", () => {
  assert.equal(readUi({ problemsTab: "notes" }).bottomPanelTab, "notifications");
  assert.equal(readUi({ problemsTab: "build" }).bottomPanelTab, "build-log");
  assert.equal(readUi({ problemsTab: "problems" }).bottomPanelTab, "problems");
  assert.equal(readUi({ bottomPanelTab: "notes" }).bottomPanelTab, "notifications");
});

test("ADR 0082 I5: an old command id's key binding is written under the new id", () => {
  const b = ["Mod-Shift-m"];
  assert.deepEqual(roundTrip({ keyBindings: { "view.problems": [] } }).keyBindings, { "view.bottomPanel": [] });
  assert.deepEqual(readKeyBindings({ "view.problems": b }), { "view.bottomPanel": b });
});

test("ADR 0082 I5: every renamed command id is read as its new one", () => {
  assert.deepEqual(Object.keys(readKeyBindings({ "view.toggleLeft": [], "view.toggleRight": [], "view.right.links": [], "view.right.attach": [], "file.save": [] })).sort(), [
    "file.save",
    "view.rightSidebar.attach",
    "view.rightSidebar.links",
    "view.toggleRightSidebar",
    "view.toggleSidebar",
  ]);
});

test("ADR 0082 I5: with both the old and the new command id, the new id's binding stays", () => {
  const old = ["Mod-1"];
  const now = ["Mod-2"];
  assert.deepEqual(readKeyBindings({ "view.problems": old, "view.bottomPanel": now }), { "view.bottomPanel": now });
  assert.deepEqual(readKeyBindings({ "view.bottomPanel": now, "view.problems": old }), { "view.bottomPanel": now });
});

test("ADR 0082 I5: the recent commands of the palette are read with the new ids", () => {
  assert.deepEqual(readUi({ recentCommands: ["view.problems", "file.save", "view.bottomPanel"] }).recentCommands, ["view.bottomPanel", "file.save"]);
});

test("ADR 0083 I2: the sidebar's panel commands view.left.<panel> are read as view.sidebar.<panel>", () => {
  assert.deepEqual(readKeyBindings({ "view.left.search": ["Mod-Shift-f"], "view.left.files": [] }), { "view.sidebar.search": ["Mod-Shift-f"], "view.sidebar.files": [] });
  assert.deepEqual(readKeyBindings({ "view.left.git": ["Mod-1"], "view.sidebar.git": ["Mod-2"] }), { "view.sidebar.git": ["Mod-2"] });
});

test("ADR 0083 I3: the recent commands keep one view.sidebar.<panel> for an old and a new id", () => {
  assert.deepEqual(readUi({ recentCommands: ["view.left.git", "view.sidebar.git"] }).recentCommands, ["view.sidebar.git"]);
  assert.deepEqual(readUi({ recentCommands: [] }).recentCommands, []);
});

test("ADR 0083 I1: no view.left. is left in app/, outside the tests and the reading of old names", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
  const app = dirname(fileURLToPath(import.meta.url));
  const found = files(app)
    .filter((f) => !f.endsWith(".test.ts") && !f.endsWith("legacy-names.ts"))
    .filter((f) => readFileSync(f, "utf8").includes("view.left."));
  assert.deepEqual(found, []);
});

test("ADR 0083 A1: a key bound to view.left.search in config.json runs view.sidebar.search", () => {
  const config = normalize({ keyBindings: { "view.left.search": ["Mod-Alt-f"] } });
  assert.deepEqual(config.keyBindings["view.sidebar.search"], ["Mod-Alt-f"]);
  assert.equal("view.left.search" in config.keyBindings, false);
});
