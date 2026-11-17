import { test } from "node:test";
import assert from "node:assert/strict";
import { metricCacheName, metricOf, readMetrics } from "./metric.ts";

const key = { commit: "c86b90f", dirty: false, partial: false, model: "qwen3-0.6b", context: 4096, coldStarts: 5 };

test("one measurement serves the three metrics: each metric is read from the same values", () => {
  const m = { firstAnswerMsP95: 1, answerMsP95: 2, peakRssMb: 3 };
  assert.equal(metricOf(m, "first-answer-ms-p95"), 1);
  assert.equal(metricOf(m, "answer-ms-p95"), 2);
  assert.equal(metricOf(m, "peak-rss-mb"), 3);
  assert.throws(() => metricOf(m, "tokens"), /unknown metric/);
});

test("the cache of a metric run is named by the commit, the model, the context and the cold starts", () => {
  const names = [
    metricCacheName(key),
    metricCacheName({ ...key, commit: "3c08218" }),
    metricCacheName({ ...key, model: "qwen3.5-4b" }),
    metricCacheName({ ...key, context: 8192 }),
    metricCacheName({ ...key, coldStarts: 1 }),
  ];
  assert.ok(names.every((n) => n !== null));
  assert.equal(new Set(names).size, names.length);
  assert.equal(metricCacheName(key), metricCacheName({ ...key }));
});

test("a tree with uncommitted changes is not cached, so its values are never reused", () => {
  assert.equal(metricCacheName({ ...key, dirty: true }), null);
  assert.equal(metricCacheName({ ...key, commit: "" }), null);
});

test("a run of some of the tasks is not cached, so the budgets never read a partial measurement", () => {
  assert.equal(metricCacheName({ ...key, partial: true }), null);
});

test("a cache file is used only when it holds the three numbers", () => {
  assert.deepEqual(readMetrics('{"firstAnswerMsP95":1,"answerMsP95":2,"peakRssMb":3}'), { firstAnswerMsP95: 1, answerMsP95: 2, peakRssMb: 3 });
  assert.equal(readMetrics('{"firstAnswerMsP95":1,"answerMsP95":2}'), null);
  assert.equal(readMetrics('{"firstAnswerMsP95":"1","answerMsP95":2,"peakRssMb":3}'), null);
  assert.equal(readMetrics("not json"), null);
  assert.equal(readMetrics(""), null);
});
