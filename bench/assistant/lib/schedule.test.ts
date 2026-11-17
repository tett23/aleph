import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { finishedMeasuring, measuredRuns, shouldMeasure, type Job } from "./schedule.ts";

const ok = (name: string): Job => ({ name, conclusion: "success" });
const all = (): Job[] => [ok("decide"), ok("measure (qwen3-0.6b, 4096)"), ok("measure (qwen3.5-4b, 8192)"), ok("history"), ok("analyze"), ok("budget-measure"), ok("budget-report"), { name: "issues", conclusion: "skipped" }];
const run = (id: number, sha: string, jobs: Job[]) => ({ id, sha, jobs });
const set = (jobs: Job[], name: string, conclusion: string | null) => jobs.map((j) => (j.name === name ? { name, conclusion } : j));

test("ADR 0085 I2: a scheduled run skips only when the head is the commit of the newest run that finished measuring", () => {
  assert.equal(shouldMeasure("schedule", "a", "a"), false);
  assert.equal(shouldMeasure("schedule", "b", "a"), true);
  assert.equal(shouldMeasure("schedule", "a", null), true);
});

test("ADR 0085 I3: a run by hand always measures", () => {
  assert.equal(shouldMeasure("workflow_dispatch", "a", "a"), true);
});

test("ADR 0085 I5: a run counts as measured only when every measure job, analyze and both budget jobs succeeded", () => {
  assert.equal(finishedMeasuring(run(1, "a", all())), true);
  assert.equal(finishedMeasuring(run(1, "a", set(all(), "measure (qwen3.5-4b, 8192)", "cancelled"))), false);
  assert.equal(finishedMeasuring(run(1, "a", set(all(), "budget-measure", "cancelled"))), false);
  assert.equal(finishedMeasuring(run(1, "a", set(all(), "budget-report", "skipped"))), false);
  assert.equal(finishedMeasuring(run(1, "a", set(all(), "analyze", "failure"))), false);
  assert.equal(finishedMeasuring(run(1, "a", all().filter((j) => !j.name.startsWith("measure")))), false);
  assert.equal(finishedMeasuring(run(1, "a", [])), false);
});

test("ADR 0085 I2, I5: a skipped night is not the newest measured run; the measured runs keep their order", () => {
  const skipped = run(3, "b", all().map((j) => (j.name === "decide" ? j : { name: j.name, conclusion: "skipped" })));
  const partial = run(2, "b", set(all(), "budget-measure", "cancelled"));
  const measured = run(1, "a", all());
  assert.deepEqual(measuredRuns([skipped, partial, measured]).map((r) => r.id), [1]);
  assert.equal(shouldMeasure("schedule", "b", measuredRuns([skipped, partial, measured])[0]?.sha ?? null), true);
  assert.deepEqual(measuredRuns([run(5, "c", all()), skipped, run(4, "b", all())]).map((r) => r.id), [5, 4]);
});

// The workflow, read line by line without a YAML parser
const workflow = readFileSync(join(import.meta.dirname, "..", "..", "..", ".github", "workflows", "assistant-bench.yml"), "utf8").split("\n");
const triggers = (lines: string[]) => {
  const start = lines.indexOf("on:");
  const end = lines.findIndex((l, i) => i > start && /^\S/.test(l));
  return lines.slice(start + 1, end).flatMap((l) => (/^ {2}[a-z_]+:/.test(l) ? [l.trim().replace(/:.*$/, "")] : []));
};
const crons = (lines: string[]) => lines.flatMap((l) => l.match(/^\s*- cron: "([^"]*)"/)?.slice(1) ?? []);
const nightly = (lines: string[]) => {
  const c = crons(lines);
  return c.length === 1 && /^\d{1,2} 18 \* \* \*$/.test(c[0]);
};

test("ADR 0085 I1: the assistant benchmark runs on schedule and by hand only", () => {
  assert.deepEqual(triggers(workflow).sort(), ["schedule", "workflow_dispatch"]);
  assert.notDeepEqual(triggers(["on:", "  push:", "    branches: [main]", "  schedule:", "  workflow_dispatch:", "jobs:"]).sort(), ["schedule", "workflow_dispatch"]);
  assert.notDeepEqual(triggers(["on:", "  pull_request:", "  schedule:", "  workflow_dispatch:", "jobs:"]).sort(), ["schedule", "workflow_dispatch"]);
});

test("ADR 0085 I4: one cron line, every day at 18 UTC (3 a.m. in Japan)", () => {
  assert.equal(nightly(workflow), true);
  assert.equal(nightly(['    - cron: "17 18 * * *"']), true);
  assert.equal(nightly(['    - cron: "17 18 * * 1"']), false);
  assert.equal(nightly(['    - cron: "17 */2 * * *"']), false);
  assert.equal(nightly(['    - cron: "17 18 * * *"', '    - cron: "47 18 * * *"']), false);
});
