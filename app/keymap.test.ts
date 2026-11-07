import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonical, conflicts, cleanBindings, DEFAULT_LEADER, effectiveBindings, expire, leaderOf, press, readBinding, reservedKey, setBinding, strokeOf, takeAway, unusableFirst, writtenBinding, type Bound,
} from "./keymap.ts";

const ev = (code: string, mods: Partial<{ meta: boolean; ctrl: boolean; alt: boolean; shift: boolean }> = {}, key = "") => ({
  key: key || (code.startsWith("Key") ? code.slice(3).toLowerCase() : code), code,
  metaKey: !!mods.meta, ctrlKey: !!mods.ctrl, altKey: !!mods.alt, shiftKey: !!mods.shift,
});

test("a key press becomes a stroke: Mod, Ctrl, Shift, Alt, then the key by its place", () => {
  assert.equal(strokeOf(ev("KeyK", { meta: true, shift: true }), true), "Mod-Shift-k");
  assert.equal(strokeOf(ev("KeyF", { alt: true, shift: true }, "Ï"), true), "Shift-Alt-f");
  assert.equal(strokeOf(ev("Digit1", { meta: true }, "1"), true), "Mod-1");
  assert.equal(strokeOf(ev("Semicolon", { meta: true }, ";"), true), "Mod-;");
  assert.equal(strokeOf(ev("Space", { ctrl: true }, " "), true), "Ctrl-Space");
  assert.equal(strokeOf(ev("Tab", { shift: true }, "Tab"), true), "Shift-Tab");
  assert.equal(strokeOf(ev("F1", {}, "F1"), true), "F1");
  assert.equal(strokeOf(ev("KeyG"), true), "g");
  assert.equal(strokeOf(ev("Minus", { meta: true }, "-"), true), "Mod-Minus");
  assert.equal(strokeOf(ev("MetaLeft", { meta: true }, "Meta"), true), null);
  assert.equal(strokeOf(ev("ShiftLeft", { shift: true }, "Shift"), true), null);
  // off the Mac, Mod is Ctrl
  assert.equal(strokeOf(ev("KeyS", { ctrl: true }), false), "Mod-s");
});

test("bindings are read into canonical strokes, Leader replaced", () => {
  assert.deepEqual(canonical("Shift-Mod-K"), "Mod-Shift-k");
  assert.deepEqual(canonical("Cmd-s"), "Mod-s");
  assert.deepEqual(readBinding("Mod-k Mod-s", "Mod-;"), ["Mod-k", "Mod-s"]);
  assert.deepEqual(readBinding("Leader f f", "Mod-;"), ["Mod-;", "f", "f"]);
  assert.deepEqual(readBinding("Leader g c", "Ctrl-j"), ["Ctrl-j", "g", "c"]);
  assert.equal(readBinding("", "Mod-;"), null);
  assert.equal(readBinding("Mod-", "Mod-;"), null);
});

test("the first stroke needs ⌘, ⌃ or ⌥, or a function key; later strokes may be bare", () => {
  assert.equal(unusableFirst("g"), true);
  assert.equal(unusableFirst("Shift-g"), true);
  assert.equal(unusableFirst("Enter"), true);
  assert.equal(unusableFirst("Backspace"), true);
  assert.equal(unusableFirst("ArrowUp"), true);
  assert.equal(unusableFirst("Mod-g"), false);
  assert.equal(unusableFirst("Alt-g"), false);
  assert.equal(unusableFirst("F5"), false);
});

test("the menu's keys cannot be bound", () => {
  for (const k of ["Mod-q", "Mod-Shift-w", "Mod-c", "Mod-v", "Mod-x", "Mod-m", "Mod-h", "Mod-Ctrl-f"]) assert.equal(reservedKey(k), true, k);
  assert.equal(reservedKey("Mod-Shift-k"), false);
});

test("the leader key falls back to the default when unusable", () => {
  assert.equal(leaderOf("Ctrl-j"), "Ctrl-j");
  assert.equal(leaderOf("j"), DEFAULT_LEADER);
  assert.equal(leaderOf("Mod-q"), DEFAULT_LEADER);
  assert.equal(leaderOf(undefined), DEFAULT_LEADER);
  assert.equal(DEFAULT_LEADER, "Mod-;");
});

const cmds = [
  { id: "git.commit", keys: ["Mod-Shift-k"] },
  { id: "editor.redo", keys: ["Mod-Shift-z", "Mod-y"] },
  { id: "file.save", keys: ["Mod-s"] },
  { id: "view.plot", keys: [] as string[] },
];

test("the user's bindings replace the defaults; an empty list unbinds", () => {
  const b = effectiveBindings(cmds, { "git.commit": ["Leader g c"], "file.save": [] }, "Mod-;");
  assert.deepEqual(b.find((x) => x.id === "git.commit")?.strokes, ["Mod-;", "g", "c"]);
  assert.equal(b.some((x) => x.id === "file.save"), false);
  assert.deepEqual(b.filter((x) => x.id === "editor.redo").map((x) => x.strokes), [["Mod-Shift-z"], ["Mod-y"]]);
});

test("cleaning drops unknown ids, unreadable or unusable bindings", () => {
  const raw = { "git.commit": ["Alt-Mod-c", "g c", "Mod-q"], "no.such": ["Mod-1"], "file.save": "Mod-s", "view.plot": [] };
  assert.deepEqual(cleanBindings(raw, new Set(cmds.map((c) => c.id))), { "git.commit": ["Mod-Alt-c"], "view.plot": [] });
  assert.deepEqual(cleanBindings(null, new Set()), {});
});

test("setting a binding keeps only what differs from the defaults", () => {
  assert.deepEqual(setBinding({}, cmds, "git.commit", ["Mod-Alt-c"]), { "git.commit": ["Mod-Alt-c"] });
  assert.deepEqual(setBinding({ "git.commit": ["Mod-Alt-c"] }, cmds, "git.commit", ["Mod-Shift-k"]), {});
  assert.deepEqual(setBinding({}, cmds, "git.commit", null), {});
});

test("conflicts: the commands bound to the same strokes, and those it would wait behind or before", () => {
  const b = effectiveBindings(cmds, { "view.plot": ["Leader g"] }, "Mod-;");
  assert.deepEqual(conflicts(b, ["Mod-s"], "git.commit"), { same: ["file.save"], prefix: [] });
  assert.deepEqual(conflicts(b, ["Mod-;", "g", "c"], "git.commit"), { same: [], prefix: ["view.plot"] });
  assert.deepEqual(conflicts(b, ["Mod-;"], "git.commit"), { same: [], prefix: ["view.plot"] });
  assert.deepEqual(conflicts(b, ["Mod-s"], "file.save"), { same: [], prefix: [] });
});

// ---- the sequence machine ----

const table: Bound[] = [
  { id: "git.commit", strokes: ["Mod-;", "g", "c"] },
  { id: "git.status", strokes: ["Mod-;", "g"] },
  { id: "file.find", strokes: ["Mod-;", "f", "f"] },
  { id: "file.save", strokes: ["Mod-s"] },
];
const T = 1000;

test("a one-stroke binding runs at once", () => {
  assert.deepEqual(press(table, null, "Mod-s", 0, T), { pending: null, run: ["file.save"], take: true, retry: false });
});

test("a key bound to nothing passes through", () => {
  assert.deepEqual(press(table, null, "x", 0, T), { pending: null, run: [], take: false, retry: false });
  assert.deepEqual(press(table, null, null, 0, T), { pending: null, run: [], take: false, retry: false });
});

test("a prefix waits, and the next strokes finish it", () => {
  const a = press(table, null, "Mod-;", 0, T);
  assert.deepEqual(a, { pending: { strokes: ["Mod-;"], at: 0 }, run: [], take: true, retry: false });
  const b = press(table, a.pending, "f", 100, T);
  assert.deepEqual(b.pending, { strokes: ["Mod-;", "f"], at: 100 });
  assert.equal(b.take, true);
  const c = press(table, b.pending, "f", 200, T);
  assert.deepEqual(c, { pending: null, run: ["file.find"], take: true, retry: false });
});

test("a shorter binding that starts a longer one waits for the time out", () => {
  const a = press(table, { strokes: ["Mod-;"], at: 0 }, "g", 100, T);
  assert.deepEqual(a.run, []);
  assert.deepEqual(a.pending, { strokes: ["Mod-;", "g"], at: 100 });
  assert.deepEqual(expire(table, a.pending), ["git.status"]);
  assert.deepEqual(press(table, a.pending, "c", 200, T).run, ["git.commit"]);
});

test("the time out runs an exact match or nothing", () => {
  assert.deepEqual(expire(table, { strokes: ["Mod-;", "f"], at: 0 }), []);
  assert.deepEqual(expire(table, null), []);
});

test("a stroke that continues nothing drops the sequence and is tried again on its own", () => {
  const a = press(table, { strokes: ["Mod-;"], at: 0 }, "x", 100, T);
  assert.deepEqual(a, { pending: null, run: [], take: false, retry: true });
  const b = press(table, { strokes: ["Mod-;"], at: 0 }, "Mod-s", 100, T);
  assert.deepEqual(b, { pending: null, run: ["file.save"], take: true, retry: true });
});

test("Escape only stops the waiting", () => {
  assert.deepEqual(press(table, { strokes: ["Mod-;"], at: 0 }, "Escape", 100, T), { pending: null, run: [], take: true, retry: false });
});

test("a stroke after the time out first runs what was waiting, then counts on its own", () => {
  const a = press(table, { strokes: ["Mod-;", "g"], at: 0 }, "Mod-s", 1500, T);
  assert.deepEqual(a.run, ["git.status", "file.save"]);
  assert.equal(a.pending, null);
});

test("changing the leader key moves every Leader binding", () => {
  const user = { "git.commit": ["Leader g c"] };
  const b = effectiveBindings([{ id: "git.commit", keys: [] }], user, "Ctrl-j");
  assert.equal(press(b, null, "Mod-;", 0, T).take, false);
  const a = press(b, null, "Ctrl-j", 0, T);
  assert.equal(a.take, true);
  assert.deepEqual(press(b, press(b, a.pending, "g", 1, T).pending, "c", 2, T).run, ["git.commit"]);
});

test("the input method composing stops the waiting and passes the key on", () => {
  assert.deepEqual(press(table, { strokes: ["Mod-;"], at: 0 }, null, 100, T), { pending: null, run: [], take: false, retry: false });
});

test("a recording that starts with the leader key is written with Leader, even alone (docs/adr/0034)", () => {
  assert.equal(writtenBinding(["Mod-;", "g", "c"], "Mod-;"), "Leader g c");
  assert.equal(writtenBinding(["Mod-;"], "Mod-;"), "Leader");
  assert.equal(writtenBinding(["Mod-k", "Mod-;"], "Mod-;"), "Mod-k Mod-;");
});

test("replacing takes the binding away from the other command (docs/adr/0034)", () => {
  const cmds = [
    { id: "file.save", keys: ["Mod-s"] },
    { id: "git.commit", keys: ["Mod-Shift-k", "Mod-s"] },
  ];
  assert.deepEqual(takeAway({}, cmds, ["git.commit"], ["Mod-s"], "Mod-;"), { "git.commit": ["Mod-Shift-k"] });
});

test("⇧⌘W is the menu's, ⌘W can be bound; ⌘W unbound from file.closeTab reaches nothing (docs/adr/0036)", () => {
  assert.equal(reservedKey("Mod-Shift-w"), true);
  assert.equal(reservedKey("Mod-w"), false);
  const cmds = [{ id: "file.closeTab", keys: ["Mod-w"] }];
  assert.deepEqual(press(effectiveBindings(cmds, {}, "Mod-;"), null, "Mod-w", 0, 1000).run, ["file.closeTab"]);
  const off = effectiveBindings(cmds, { "file.closeTab": [] }, "Mod-;");
  assert.deepEqual(press(off, null, "Mod-w", 0, 1000), { pending: null, run: [], take: false, retry: false });
});
