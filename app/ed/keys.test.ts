import { test } from "node:test";
import assert from "node:assert/strict";
import { matchKey } from "./keys.ts";

const ev = (key: string, code: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({ key, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

test("Mod is ⌘ on macOS", () => {
  assert.ok(matchKey("Mod-s", ev("s", "KeyS", { metaKey: true }), true));
  assert.ok(!matchKey("Mod-s", ev("s", "KeyS", { ctrlKey: true }), true));
  assert.ok(matchKey("Mod-s", ev("s", "KeyS", { ctrlKey: true }), false));
});

test("modifiers must match exactly", () => {
  assert.ok(!matchKey("Mod-z", ev("z", "KeyZ", { metaKey: true, shiftKey: true }), true));
  assert.ok(matchKey("Mod-Shift-z", ev("Z", "KeyZ", { metaKey: true, shiftKey: true }), true));
});

test("⌥ that changes the character still matches by the key's place", () => {
  assert.ok(matchKey("Shift-Alt-f", ev("Ï", "KeyF", { altKey: true, shiftKey: true }), true));
  assert.ok(!matchKey("Shift-Alt-f", ev("Ï", "KeyG", { altKey: true, shiftKey: true }), true));
});

test("named keys", () => {
  assert.ok(matchKey("Tab", ev("Tab", "Tab"), true));
  assert.ok(matchKey("Escape", ev("Escape", "Escape"), true));
  assert.ok(matchKey("Mod-Enter", ev("Enter", "Enter", { metaKey: true }), true));
});
