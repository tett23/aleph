import { test } from "node:test";
import assert from "node:assert/strict";
import { withBuildDir, withLock } from "./buildlock.ts";

// docs/adr/0058: the builds that write a project's build/ run one after another
test("writers of one project's build/ run one after another; other projects do not wait", async () => {
  const log: string[] = [];
  let release: (() => void) | null = null;
  const a = withBuildDir("/p", async () => {
    log.push("a start");
    await new Promise<void>((r) => (release = r));
    log.push("a end");
  });
  const b = withBuildDir("/p", async () => void log.push("b"));
  const c = withBuildDir("/q", async () => void log.push("c"));
  await c;
  assert.deepEqual(log, ["a start", "c"]);
  release!();
  await Promise.all([a, b]);
  assert.deepEqual(log, ["a start", "c", "a end", "b"]);
});

test("a failed writer does not stop the next", async () => {
  await assert.rejects(withBuildDir("/r", async () => Promise.reject(new Error("x"))));
  assert.equal(await withBuildDir("/r", async () => 1), 1);
});

// docs/adr/0062: off the main thread, the runs that must not overlap go one after another by key
test("withLock: one key runs in the order asked, one after another; other keys run alongside; a failure does not stop the next", async () => {
  const log: string[] = [];
  let release: (() => void) | null = null;
  const a = withLock("git\n/w", async () => {
    log.push("a start");
    await new Promise<void>((r) => (release = r));
    log.push("a end");
  });
  const b = withLock("git\n/w", async () => void log.push("b"));
  const c = withLock("git\n/v", async () => void log.push("c"));
  await c;
  assert.deepEqual(log, ["a start", "c"]);
  release!();
  await Promise.all([a, b]);
  assert.deepEqual(log, ["a start", "c", "a end", "b"]);
  await assert.rejects(withLock("k", async () => Promise.reject(new Error("x"))));
  assert.equal(await withLock("k", async () => 2), 2);
});

test("withBuildDir and withLock share nothing unless their keys meet", async () => {
  const log: string[] = [];
  let release: (() => void) | null = null;
  const a = withBuildDir("/p", async () => {
    await new Promise<void>((r) => (release = r));
    log.push("build");
  });
  await withLock("/p", async () => void log.push("other"));
  release!();
  await a;
  assert.deepEqual(log, ["other", "build"]);
});
