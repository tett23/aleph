import { test } from "node:test";
import assert from "node:assert/strict";
import { devBadge, versionLabel } from "./build.ts";

test("the toolbar marks a debug build only", () => {
  assert.match(devBadge(true), />dev</);
  assert.match(devBadge(true), /data-tauri-drag-region/);
  assert.equal(devBadge(false), "");
});

test("the settings version notes a debug build only", () => {
  assert.equal(versionLabel("1.0.0-rc1", true), "1.0.0-rc1 (dev)");
  assert.equal(versionLabel("1.0.0-rc1", false), "1.0.0-rc1");
  assert.equal(versionLabel("", true), "(dev)");
  assert.equal(versionLabel("", false), "");
});
