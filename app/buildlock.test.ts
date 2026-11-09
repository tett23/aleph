import { test } from "node:test";
import assert from "node:assert/strict";
import { withBuildDir } from "./buildlock.ts";

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
