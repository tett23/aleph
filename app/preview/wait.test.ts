import { test } from "node:test";
import assert from "node:assert/strict";
import { createWaiter, remaining, WAIT_MS } from "./wait.ts";

// docs/adr/0056: the pages are built again once the input has stopped for 5 s

test("the time left is 0 once 5 s have passed since the last edit, else what is left", () => {
  assert.equal(WAIT_MS, 5000);
  assert.equal(remaining(undefined, 10_000), 0);
  assert.equal(remaining(1_000, 6_000), 0);
  assert.equal(remaining(1_000, 9_000), 0);
  assert.equal(remaining(4_000, 6_000), 3_000);
});

const fakeClock = () => {
  let now = 0;
  let id = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    set: (fn: () => void, ms: number) => (timers.set(++id, { at: now + ms, fn }), id),
    clear: (i: number) => void timers.delete(i),
    advance: (ms: number) => {
      now += ms;
      for (const [i, t] of [...timers].sort((a, b) => a[1].at - b[1].at))
        if (t.at <= now && timers.has(i)) {
          timers.delete(i);
          t.fn();
        }
    },
  };
};

test("a build asked for after a save waits until 5 s after the last edit, and an edit meanwhile counts again", () => {
  const c = fakeClock();
  const w = createWaiter(c);
  const runs: string[] = [];
  w.edited("/p");
  c.advance(2_000);
  w.request("/p", () => runs.push("built"));
  assert.ok(w.waiting("/p"));
  c.advance(2_000); // 4 s after the edit
  w.edited("/p");
  c.advance(4_000); // 4 s after the second edit
  assert.deepEqual(runs, []);
  c.advance(1_000);
  assert.deepEqual(runs, ["built"]);
  assert.ok(!w.waiting("/p"));
});

test("saves while waiting make one build", () => {
  const c = fakeClock();
  const w = createWaiter(c);
  const runs: number[] = [];
  w.edited("/p");
  w.request("/p", () => runs.push(1));
  c.advance(1_000);
  w.request("/p", () => runs.push(2));
  c.advance(10_000);
  assert.deepEqual(runs, [2]);
});

test("with no recent edit the build runs at once; projects wait apart", () => {
  const c = fakeClock();
  const w = createWaiter(c);
  const runs: string[] = [];
  c.advance(10_000);
  w.edited("/a");
  w.request("/b", () => runs.push("b"));
  w.request("/a", () => runs.push("a"));
  c.advance(0);
  assert.deepEqual(runs, ["b"]);
  c.advance(5_000);
  assert.deepEqual(runs, ["b", "a"]);
});

test("a build run now drops the waiting one", () => {
  const c = fakeClock();
  const w = createWaiter(c);
  const runs: string[] = [];
  w.edited("/p");
  w.request("/p", () => runs.push("late"));
  w.cancel("/p");
  c.advance(10_000);
  assert.deepEqual(runs, []);
  assert.ok(!w.waiting("/p"));
});
