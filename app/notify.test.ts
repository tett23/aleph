import { test } from "node:test";
import assert from "node:assert/strict";
import { createNotifications, HISTORY_MAX, MAX_SHOWN, TIMEOUT } from "./notify.ts";

// a clock the tests move by hand
const fakeClock = () => {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    clock: {
      now: () => now,
      set: (fn: () => void, ms: number) => {
        timers.set(++seq, { at: now + ms, fn });
        return seq;
      },
      clear: (id: number) => void timers.delete(id),
    },
    advance: (ms: number) => {
      now += ms;
      for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at))
        if (t.at <= now && timers.has(id)) {
          timers.delete(id);
          t.fn();
        }
    },
  };
};

const shownMessages = (n: ReturnType<typeof createNotifications>) => n.shown().notes.map((x) => x.message);

test("a timed notification goes after 5 seconds; a sticky one stays (docs/adr/0064)", () => {
  const c = fakeClock();
  const n = createNotifications(c.clock);
  n.notify({ message: "a" });
  n.notify({ message: "b", sticky: true });
  c.advance(TIMEOUT - 1);
  assert.deepEqual(shownMessages(n), ["a", "b"]);
  c.advance(1);
  assert.deepEqual(shownMessages(n), ["b"]);
  c.advance(60_000);
  assert.deepEqual(shownMessages(n), ["b"]);
});

test("while the pointer is on a timed notification it does not count; it counts again after", () => {
  const c = fakeClock();
  const n = createNotifications(c.clock);
  const h = n.notify({ message: "a" });
  c.advance(3000);
  n.hover(h.id, true);
  c.advance(10_000);
  assert.deepEqual(shownMessages(n), ["a"]);
  n.hover(h.id, false);
  c.advance(TIMEOUT - 1);
  assert.deepEqual(shownMessages(n), ["a"]);
  c.advance(1);
  assert.deepEqual(shownMessages(n), []);
});

test("a notification with the same key takes the place of the one before; the key closes it", () => {
  const c = fakeClock();
  const n = createNotifications(c.clock);
  n.notify({ message: "食い違い 1", key: "conflict:/a.gm", sticky: true });
  n.notify({ message: "食い違い 2", key: "conflict:/a.gm", sticky: true });
  assert.deepEqual(shownMessages(n), ["食い違い 2"]);
  // in the history, one row with the times it was given
  assert.deepEqual(
    n.history().map((x) => [x.message, x.repeats]),
    [["食い違い 2", 2]],
  );
  n.dismissKey("conflict:/a.gm");
  assert.deepEqual(shownMessages(n), []);
  assert.equal(n.history().length, 1);
});

test("beyond four shown, the oldest timed ones close; sticky ones stay and the rest is counted", () => {
  const c = fakeClock();
  const n = createNotifications(c.clock);
  n.notify({ message: "t1" });
  n.notify({ message: "s1", sticky: true });
  n.notify({ message: "t2" });
  n.notify({ message: "s2", sticky: true });
  n.notify({ message: "t3" });
  assert.deepEqual(shownMessages(n), ["s1", "t2", "s2", "t3"]);
  for (const m of ["s3", "s4", "s5"]) n.notify({ message: m, sticky: true });
  // timed ones closed first; sticky ones never closed for the count: the newest MAX_SHOWN shown, the rest counted
  assert.equal(n.shown().notes.length, MAX_SHOWN);
  assert.deepEqual(shownMessages(n), ["s2", "s3", "s4", "s5"]);
  assert.equal(n.shown().more, 1);
  n.expand(true);
  assert.deepEqual(shownMessages(n), ["s1", "s2", "s3", "s4", "s5"]);
  assert.equal(n.shown().more, 0);
});

test("a button runs once and closes the notification; one marked keep does not close it", () => {
  const c = fakeClock();
  const n = createNotifications(c.clock);
  let ran = 0;
  let kept = 0;
  const h = n.notify({ message: "a", sticky: true, actions: [{ label: "直す", run: () => ran++ }, { label: "見る", run: () => kept++, keep: true }] });
  n.press(h.id, 1);
  assert.equal(kept, 1);
  assert.deepEqual(shownMessages(n), ["a"]);
  n.press(h.id, 0);
  n.press(h.id, 0);
  assert.equal(ran, 1);
  assert.deepEqual(shownMessages(n), []);
});

test("the history keeps closed and gone notifications newest first, with whether each is still shown", () => {
  const c = fakeClock();
  const n = createNotifications(c.clock);
  n.notify({ message: "古い" });
  c.advance(TIMEOUT);
  const h = n.notify({ message: "閉じる", sticky: true });
  n.dismiss(h.id);
  n.notify({ message: "新しい", level: "error", sticky: true });
  assert.deepEqual(
    n.history().map((x) => [x.message, x.live]),
    [
      ["新しい", true],
      ["閉じる", false],
      ["古い", false],
    ],
  );
  // clearing keeps what is still shown
  n.clearHistory();
  assert.deepEqual(
    n.history().map((x) => x.message),
    ["新しい"],
  );
});

test("the history keeps at most 500, dropping the oldest", () => {
  const c = fakeClock();
  const n = createNotifications(c.clock);
  for (let i = 0; i < HISTORY_MAX + 20; i++) n.notify({ message: `m${i}` });
  assert.equal(n.history().length, HISTORY_MAX);
  assert.equal(n.history()[0].message, `m${HISTORY_MAX + 19}`);
  assert.equal(n.history().at(-1)!.message, "m20");
});

test("unseen: counted since the tab was last seen, with whether an error is among them; seeing clears it", () => {
  const c = fakeClock();
  const n = createNotifications(c.clock);
  n.notify({ message: "a" });
  n.notify({ message: "b", level: "warning" });
  assert.deepEqual(n.unseen(), { count: 2, error: false });
  n.notify({ message: "c", level: "error" });
  assert.deepEqual(n.unseen(), { count: 3, error: true });
  n.seen();
  assert.deepEqual(n.unseen(), { count: 0, error: false });
});

test("a notification recorded only (from another window) goes into the history, not on the screen", () => {
  const c = fakeClock();
  const n = createNotifications(c.clock);
  n.record({ message: "別のウィンドウ", level: "error" });
  assert.deepEqual(shownMessages(n), []);
  assert.deepEqual(
    n.history().map((x) => [x.message, x.live]),
    [["別のウィンドウ", false]],
  );
  assert.deepEqual(n.unseen(), { count: 1, error: true });
});

test("listeners hear every change; the message can be changed", () => {
  const c = fakeClock();
  const n = createNotifications(c.clock);
  let heard = 0;
  n.subscribe(() => heard++);
  const h = n.notify({ message: "a", sticky: true });
  h.update("b");
  h.dismiss();
  assert.equal(heard, 3);
  assert.equal(n.history()[0].message, "b");
});

test("ADR 0078 I7: a progress notification is updated in place by its key, without adding a toast", () => {
  const c = fakeClock();
  const n = createNotifications(c.clock);
  n.notify({ key: "copy", message: "novel にコピーしています", sticky: true, progress: { value: 0.1, text: "0 / 2" } });
  n.notify({ key: "copy", message: "novel にコピーしています", sticky: true, progress: { value: 0.6, text: "1 / 2" } });
  const shown = n.shown().notes;
  assert.equal(shown.length, 1);
  assert.deepEqual(shown[0].progress, { value: 0.6, text: "1 / 2" });
  assert.equal(shown[0].repeats, 1);
});

test("ADR 0078 I7: progress notifications stay out of the history; the result replacing one is kept once", () => {
  const c = fakeClock();
  const n = createNotifications(c.clock);
  n.seen();
  n.notify({ key: "copy", message: "コピーしています", sticky: true, progress: { value: 0, text: "0 / 1" } });
  n.notify({ key: "copy", message: "コピーしています", sticky: true, progress: { value: 0.5, text: "0 / 1" } });
  assert.equal(n.history().length, 0);
  assert.equal(n.unseen().count, 0);
  n.notify({ key: "copy", message: "コピーしました：a.md" });
  assert.deepEqual(
    n.history().map((x) => [x.message, x.repeats]),
    [["コピーしました：a.md", 1]],
  );
  assert.deepEqual(shownMessages(n), ["コピーしました：a.md"]);
  assert.equal(n.unseen().count, 1);
});

test("ADR 0078 I7: a closed progress notification is not shown again by later values", () => {
  const c = fakeClock();
  const n = createNotifications(c.clock);
  const h = n.notify({ key: "copy", message: "コピーしています", sticky: true, progress: { value: 0, text: "0 / 1" } });
  h.dismiss();
  n.notify({ key: "copy", message: "コピーしています", sticky: true, progress: { value: 0.5, text: "0 / 1" } });
  assert.equal(n.shown().notes.length, 0);
  n.notify({ key: "copy", message: "コピーしました" });
  assert.deepEqual(shownMessages(n), ["コピーしました"]);
});

test("ADR 0078 I8: the value of a progress notification is kept within 0 and 1", () => {
  const c = fakeClock();
  const n = createNotifications(c.clock);
  n.notify({ key: "k", message: "m", sticky: true, progress: { value: 1.5, text: "" } });
  assert.equal(n.shown().notes[0].progress!.value, 1);
  n.notify({ key: "k", message: "m", sticky: true, progress: { value: -1, text: "" } });
  assert.equal(n.shown().notes[0].progress!.value, 0);
});

test("ADR 0106 I1, I2, I3: closing a sticky error clears its contribution and preserves the history row", () => {
  const n = createNotifications(fakeClock().clock);
  const h = n.notify({ message: "error", level: "error", sticky: true, actions: [{ label: "fix", run() {} }] });
  n.notify({ message: "info", sticky: true });
  n.notify({ message: "warning", level: "warning", sticky: true });
  const { message, level, at, repeats } = n.history().find((note) => note.id === h.id)!;
  n.dismissByUser(h.id);
  assert.deepEqual(n.unseen(), { count: 2, error: false });
  const closed = n.history().find((note) => note.id === h.id)!;
  assert.deepEqual(closed, { ...closed, message, level, at, repeats, actions: [], live: false });
});

test("ADR 0106 I1, I3, I4: keyed occurrences keep their original levels and only their unseen occurrences are cleared", () => {
  const n = createNotifications(fakeClock().clock);
  const notify = (level: "error" | "info") => n.notify({ message: level, key: "group", level, sticky: true });
  const oldest = notify("error");
  notify("info");
  const group = notify("info");
  const other = n.notify({ message: "other", level: "error", sticky: true });
  n.dismissByUser(oldest.id);
  assert.deepEqual(n.unseen(), { count: 4, error: true });
  n.dismissByUser(other.id);
  assert.deepEqual(n.unseen(), { count: 3, error: true });
  n.dismissByUser(group.id);
  n.dismissByUser(group.id);
  assert.deepEqual(n.unseen(), { count: 0, error: false });
  assert.equal(n.history().find((note) => note.id === group.id)?.repeats, 3);
  notify("error");
  n.seen();
  const afterSeen = notify("info");
  assert.deepEqual(n.unseen(), { count: 1, error: false });
  n.dismissByUser(afterSeen.id);
  assert.deepEqual(n.unseen(), { count: 0, error: false });
  n.dismissByUser(notify("info").id);
  assert.equal(n.history()[0].repeats, 6);
});

test("ADR 0106 I4: dismissal acknowledges only a user-closed sticky notice", () => {
  const c = fakeClock();
  const n = createNotifications(c.clock);
  n.notify({ message: "timer" });
  c.advance(TIMEOUT);
  n.dismissByUser(n.notify({ message: "user-closed timed" }).id);
  n.notify({ message: "by handle", sticky: true }).dismiss();
  n.notify({ message: "by key", sticky: true, key: "key" });
  n.dismissKey("key");
  n.dismissByUser(n.notify({ message: "progress", sticky: true, progress: { value: 0, text: "" } }).id);
  let ran = 0;
  const h = n.notify({ message: "actions", sticky: true, actions: [
    { label: "keep", run: () => ran++, keep: true },
    { label: "close", run: () => ran++ },
  ] });
  n.press(h.id, 0);
  assert.equal(n.unseen().count, 5);
  n.press(h.id, 1);
  n.press(h.id, 1);
  assert.equal(ran, 2);
  assert.equal(n.unseen().count, 4);
  const seen = n.notify({ message: "seen", sticky: true });
  n.seen();
  n.notify({ message: "unrelated" });
  n.dismissByUser(seen.id);
  assert.equal(n.unseen().count, 1);
});

test("ADR 0106 I4: history eviction and clearing preserve unseen counts and error levels", () => {
  const n = createNotifications(fakeClock().clock);
  n.notify({ message: "evicted error", level: "error" });
  for (let i = 0; i < HISTORY_MAX; i++) n.notify({ message: "timed" });
  assert.equal(n.history().some((note) => note.message === "evicted error"), false);
  n.clearHistory();
  const h = n.notify({ message: "sticky", sticky: true });
  n.dismissByUser(h.id);
  assert.deepEqual(n.unseen(), { count: HISTORY_MAX + 1, error: true });
  n.seen();
  assert.deepEqual(n.unseen(), { count: 0, error: false });
});

test("ADR 0106 I5: delivery order, duplicates, identical text and window recreation preserve identity", () => {
  const n = createNotifications(fakeClock().clock);
  const first = { type: "added", origin: "plot:original", id: 1, message: "same", level: "error", sticky: true } as const;
  const closed = { type: "acknowledged", origin: first.origin, ids: [1] } as const;
  n.receive(closed);
  n.receive(closed);
  n.receive(first);
  n.receive(first);
  const next = { ...first, id: 2 };
  n.receive(next);
  n.receive({ ...first, origin: "plot:recreated" });
  n.receive(closed);
  assert.equal(n.history().length, 3);
  assert.deepEqual(n.unseen(), { count: 2, error: true });
  n.receive({ ...closed, ids: [2] });
  assert.equal(n.history().length, 3);
  assert.deepEqual(n.unseen(), { count: 1, error: true });
});

test("ADR 0106 I5: forwarding a grouped acknowledgment covers exactly the source occurrences", () => {
  const c = fakeClock();
  const main = createNotifications(c.clock);
  const pending: Parameters<typeof main.receive>[0][] = [];
  const source = createNotifications(c.clock, { origin: "pages:instance", send: (event) => pending.push(event) });
  source.notify({ message: "old", key: "group", sticky: true, level: "error" });
  source.seen();
  const grouped = source.notify({ message: "new", key: "group", sticky: true });
  source.dismissByUser(grouped.id);
  source.notify({ message: "next", key: "group", sticky: true });
  source.notify({ message: "progress", sticky: true, progress: { value: 0, text: "" } });
  assert.equal(pending.length, 4);
  for (const i of [0, 2, 1, 3, 2]) main.receive(pending[i]);
  assert.deepEqual(main.unseen(), { count: 1, error: false });
  assert.deepEqual(main.history().map(({ message, repeats, live }) => ({ message, repeats, live })), [
    { message: "next", repeats: 3, live: false },
  ]);
});

test("ADR 0106 I5: a delayed grouped occurrence keeps the newest message and time", () => {
  const n = createNotifications(fakeClock().clock);
  const source = { type: "added", origin: "pages:instance", key: "group", sticky: true } as const;
  const addedFirst = { ...source, id: 1, message: "older", at: 100, level: "error" } as const;
  const addedSecond = { ...source, id: 2, message: "newer", at: 200, level: "info" } as const;
  n.receive(addedSecond);
  n.receive(addedFirst);
  n.receive(addedFirst);
  assert.deepEqual(n.unseen(), { count: 2, error: true });
  n.receive({ type: "acknowledged", origin: source.origin, ids: [1] });
  assert.deepEqual(n.unseen(), { count: 1, error: false });
  assert.deepEqual(n.history().map(({ message, at, level, repeats }) => ({ message, at, level, repeats })), [
    { message: "newer", at: 200, level: "info", repeats: 2 },
  ]);
});
