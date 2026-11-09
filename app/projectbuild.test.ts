import { test } from "node:test";
import assert from "node:assert/strict";
import { buildArgs, buildStatus, createRunner, DEFAULT_OPTIONS, readBuildOptions, readBuildResult } from "./projectbuild.ts";

// docs/adr/0058: building a project from Aleph

test("the arguments: the defaults, then a target, a profile and marks", () => {
  assert.deepEqual(buildArgs(DEFAULT_OPTIONS), ["build", "--format", "json", "--no-notices", "--profile", "dev"]);
  assert.deepEqual(buildArgs({ target: "pdf", profile: "prod", marks: "japanese" }), [
    "build", "--format", "json", "--no-notices", "--profile", "prod", "--target", "pdf", "--marks", "japanese",
  ]);
  assert.deepEqual(buildArgs({ target: "all", profile: "dev", marks: "western" }), ["build", "--format", "json", "--no-notices", "--profile", "dev", "--marks", "western"]);
  // marks are for the PDF only
  assert.ok(!buildArgs({ target: "html", profile: "dev", marks: "japanese" }).includes("--marks"));
});

test("the kept options: unknown or malformed values are the defaults", () => {
  assert.deepEqual(readBuildOptions(undefined), DEFAULT_OPTIONS);
  assert.deepEqual(readBuildOptions("pdf"), DEFAULT_OPTIONS);
  assert.deepEqual(readBuildOptions({ target: "docx", profile: "prod", marks: 3 }), { ...DEFAULT_OPTIONS, profile: "prod" });
  assert.deepEqual(readBuildOptions({ target: "epub", profile: "dev", marks: "none" }), { target: "epub", profile: "dev", marks: "none" });
});

test("the result: a JSON array is the diagnostics; anything else a failure with its first 20 lines", () => {
  const ok = readBuildResult(0, `[{"code":"E1","severity":"error","message":"m"}]`, "");
  assert.equal(ok.failed, false);
  assert.equal(ok.items.length, 1);
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
  const bad = readBuildResult(1, lines, "");
  assert.equal(bad.failed, true);
  assert.equal(bad.items.length, 1);
  assert.equal(bad.items[0].severity, "error");
  assert.equal(bad.items[0].span, undefined);
  assert.equal(bad.items[0].message.split("\n").length, 20);
  assert.equal(readBuildResult(127, "", "").failed, true);
  assert.match(readBuildResult(127, "", "").items[0].message, /終了コード 127/);
});

test("the status item: running, errors, warnings, success, never run", () => {
  assert.equal(buildStatus(null, false), null);
  assert.deepEqual(buildStatus(null, true), { cls: "running", text: "● build" });
  const r = (severities: string[], failed = false) => ({ failed, seconds: 0.7, items: severities.map((s) => ({ code: "", severity: s as "error", message: "" })) });
  assert.deepEqual(buildStatus(r(["error", "warning"]), false), { cls: "ng", text: "● build 0.7 秒" });
  assert.deepEqual(buildStatus(r(["warning"]), false), { cls: "warn", text: "● build 0.7 秒" });
  assert.deepEqual(buildStatus(r(["notice"]), false), { cls: "ok", text: "● build 0.7 秒" });
  assert.deepEqual(buildStatus(r([], true), false), { cls: "ng", text: "● build 0.7 秒" });
});

test("the runner: one build at a time per project; asks meanwhile make one more run after it", async () => {
  const runs: string[] = [];
  let release: (() => void) | null = null;
  const run = createRunner(async (p: string) => {
    runs.push(p);
    await new Promise<void>((r) => (release = r));
  });
  void run("/p");
  void run("/p");
  void run("/p");
  await Promise.resolve();
  assert.deepEqual(runs, ["/p"]);
  release!();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(runs, ["/p", "/p"]);
  release!();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(runs, ["/p", "/p"]);
});
