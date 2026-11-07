import { test } from "node:test";
import assert from "node:assert/strict";
import { createUiState } from "./uistate.ts";

test("values are read from the kept state, written through the save function, merged", () => {
  const saved: Record<string, unknown>[] = [];
  const ui = createUiState({ pageZoom: 2 }, (u) => saved.push({ ...u }));
  assert.equal(ui.get("pageZoom", 1), 2);
  assert.equal(ui.get("ganttZoom", 1), 1);
  ui.set("ganttZoom", 1.5);
  ui.merge({ left: "git", vertical: true });
  assert.deepEqual(saved.at(-1), { pageZoom: 2, ganttZoom: 1.5, left: "git", vertical: true });
  assert.equal(ui.get("ganttZoom", 1), 1.5);
});

test("a value of another type is the default", () => {
  const ui = createUiState({ pageZoom: "big" }, () => {});
  assert.equal(ui.get("pageZoom", 1), 1);
});

test("a preview or plot window sends only what it changed", async () => {
  const { windowUiState } = await import("./uistate.ts");
  const sent: Record<string, unknown>[] = [];
  const ui = windowUiState({ left: "git", pageZoom: 1 }, (p) => sent.push(p));
  ui.set("pageZoom", 2);
  assert.equal(ui.get("pageZoom", 1), 2);
  assert.deepEqual(sent, [{ pageZoom: 2 }]);
});
