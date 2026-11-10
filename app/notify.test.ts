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
