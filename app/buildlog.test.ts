import { test } from "node:test";
import assert from "node:assert/strict";
import { createBuildLogs, revealBuildAction, renderBuildLog } from "./buildlog.ts";
import type { Out } from "./api.ts";

test("ADR 0069 invariants 1 and 2: projects finishing in reverse order retain their actions and logs", async () => {
  const logs = createBuildLogs();
  assert.equal(logs.get("/a"), undefined);
  let finish!: (out: Out) => void;
  const pending = new Promise<Out>((resolve) => { finish = resolve; });
  const actions = [];
  const paths: string[] = [];
  const reveal = (path: string) => { paths.push(path); };
  const first = logs.run("/a", ["build", "--target", "pdf"], () => pending);
  assert.match(renderBuildLog(logs.get("/a")!), /実行中/);
  await logs.run("/b", ["build"], async () => ({ code: 0, stdout: "built B", stderr: "[]" }));
  actions.push(revealBuildAction("/b", reveal));
  finish({ code: 0, stdout: "built A", stderr: '[{"severity":"warning"}]' });
  await first;
  actions.push(revealBuildAction("/a", reveal));
  for (const action of actions) action.run();
  assert.deepEqual(paths, ["/b/build", "/a/build"]);
  assert.match(renderBuildLog(logs.get("/a")!), /built A/);
  assert.match(renderBuildLog(logs.get("/b")!), /built B/);
  await logs.run("/a", ["build"], async () => ({ code: 9, stdout: "", stderr: "<bad>" }));
  const replaced = renderBuildLog(logs.get("/a")!);
  for (const part of ["標準出力", "標準エラー出力", "&lt;bad&gt;", "9"]) assert.ok(replaced.includes(part));
  assert.doesNotMatch(replaced, /built A|--target/);
});

test("ADR 0069 invariant 2: a launch failure retains the arguments and reason", async () => {
  const logs = createBuildLogs();
  await logs.run("/a", ["build", "--profile", "prod"], async () => { throw new Error("no binary"); });
  const html = renderBuildLog(logs.get("/a")!);
  for (const part of ["build --profile prod", "起動失敗", "no binary"]) assert.ok(html.includes(part));
});
