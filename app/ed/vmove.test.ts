import { test } from "node:test";
import assert from "node:assert/strict";
import { verticalMove } from "./vmove.ts";

const k = (key: string, mods: Partial<{ shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean }> = {}) => ({ key, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, ...mods });
const mv = (direction: "forward" | "backward", granularity: string, alter: "move" | "extend" = "move") => ({ alter, direction, granularity });

test("plain arrows: ↓↑ along the line by character, ←→ between lines", () => {
  assert.deepEqual(verticalMove(k("ArrowDown")), mv("forward", "character"));
  assert.deepEqual(verticalMove(k("ArrowUp")), mv("backward", "character"));
  assert.deepEqual(verticalMove(k("ArrowLeft")), mv("forward", "line"));
  assert.deepEqual(verticalMove(k("ArrowRight")), mv("backward", "line"));
});

test("⌥: words along the line, paragraph ends between lines", () => {
  assert.deepEqual(verticalMove(k("ArrowDown", { altKey: true })), mv("forward", "word"));
  assert.deepEqual(verticalMove(k("ArrowUp", { altKey: true })), mv("backward", "word"));
  assert.deepEqual(verticalMove(k("ArrowLeft", { altKey: true })), mv("forward", "paragraphboundary"));
  assert.deepEqual(verticalMove(k("ArrowRight", { altKey: true })), mv("backward", "paragraphboundary"));
});

test("⌘: the line's ends along the line, the document's ends between lines", () => {
  assert.deepEqual(verticalMove(k("ArrowDown", { metaKey: true })), mv("forward", "lineboundary"));
  assert.deepEqual(verticalMove(k("ArrowUp", { metaKey: true })), mv("backward", "lineboundary"));
  assert.deepEqual(verticalMove(k("ArrowLeft", { metaKey: true })), { doc: "end", extend: false });
  assert.deepEqual(verticalMove(k("ArrowRight", { metaKey: true })), { doc: "start", extend: false });
});

test("⇧ extends the selection the same way", () => {
  assert.deepEqual(verticalMove(k("ArrowDown", { shiftKey: true })), mv("forward", "character", "extend"));
  assert.deepEqual(verticalMove(k("ArrowLeft", { shiftKey: true })), mv("forward", "line", "extend"));
  assert.deepEqual(verticalMove(k("ArrowUp", { shiftKey: true, altKey: true })), mv("backward", "word", "extend"));
  assert.deepEqual(verticalMove(k("ArrowDown", { shiftKey: true, metaKey: true })), mv("forward", "lineboundary", "extend"));
  assert.deepEqual(verticalMove(k("ArrowLeft", { shiftKey: true, metaKey: true })), { doc: "end", extend: true });
  assert.deepEqual(verticalMove(k("ArrowRight", { shiftKey: true, metaKey: true })), { doc: "start", extend: true });
});

test("⌃, ⌘⌥ and other keys are left to the browser", () => {
  assert.equal(verticalMove(k("ArrowDown", { ctrlKey: true })), null);
  assert.equal(verticalMove(k("ArrowLeft", { ctrlKey: true, shiftKey: true })), null);
  assert.equal(verticalMove(k("ArrowDown", { metaKey: true, altKey: true })), null);
  assert.equal(verticalMove(k("PageDown")), null);
  assert.equal(verticalMove(k("Home")), null);
  assert.equal(verticalMove(k("a")), null);
});
