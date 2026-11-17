import { test } from "node:test";
import assert from "node:assert/strict";
import { median, p95 } from "./stats.ts";
import { pickDefault, qualifies, regressions, type Summary } from "./summary.ts";

const s = (over: Partial<Summary> = {}): Summary => ({
  key: "m@4096",
  model: "m",
  context: 4096,
  firstAnswerMsP95: 5000,
  answerMsMedian: 1000,
  answerMsP95: 2000,
  peakRssMb: 1000,
  successRate: 0.8,
  successByKind: { style: 0.8, command: 0.8 },
  essentialFailed: [],
  ...over,
});

test("the median and the nearest-rank p95", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(p95([1, 2, 3, 4, 5]), 5);
  assert.equal(p95(Array.from({ length: 100 }, (_, i) => i + 1)), 95);
  assert.ok(Number.isNaN(median([])));
});

const four = [[s()], [s()], [s()], [s()]];

test("ADR 0081 regressions: with fewer than four previous runs nothing is judged", () => {
  assert.deepEqual(regressions([s({ answerMsP95: 99999, essentialFailed: ["x"] })], four.slice(0, 3), []), []);
});

test("ADR 0081 regressions: a configuration with fewer than four previous results is not judged", () => {
  const other = [[s()], [s()], [s()], [s({ key: "n@4096" })]];
  assert.deepEqual(regressions([s({ answerMsP95: 99999 })], other, []), []);
});

test("ADR 0081 regressions: 20% worse than the median of the previous four is a regression; less is not", () => {
  assert.deepEqual(regressions([s({ answerMsP95: 2399 })], four, []), []);
  const r = regressions([s({ answerMsP95: 2400, answerMsMedian: 1200, peakRssMb: 1200 })], four, []);
  assert.deepEqual(
    r.map((x) => x.metric),
    ["answer-ms-median", "answer-ms-p95", "peak-rss-mb"],
  );
  assert.equal(r[1].baseline, 2000);
});

test("ADR 0081 regressions: a success rate five points below the median is a regression", () => {
  assert.deepEqual(regressions([s({ successRate: 0.76 })], four, []), []);
  assert.deepEqual(
    regressions([s({ successRate: 0.75 })], four, []).map((x) => x.metric),
    ["success-rate"],
  );
});

test("ADR 0081 regressions: one essential task failing is a regression", () => {
  assert.deepEqual(
    regressions([s({ essentialFailed: ["gm-ruby"] })], four, []).map((x) => x.metric),
    ["essential"],
  );
});

test("ADR 0081 regressions: the same regression in the previous run makes it consecutive", () => {
  const r = regressions([s({ peakRssMb: 5000 })], four, [{ key: "m@4096", metric: "peak-rss-mb" }, { key: "m@8192", metric: "answer-ms-p95" }]);
  assert.deepEqual(r.map((x) => [x.metric, x.consecutive]), [["peak-rss-mb", true]]);
  assert.equal(regressions([s({ peakRssMb: 5000 })], four, [{ key: "m@4096", metric: "answer-ms-p95" }])[0].consecutive, false);
});

test("ADR 0081 default model: a configuration qualifies with every essential task, 70% overall, 50% per kind and the budgets", () => {
  assert.equal(qualifies(s()).ok, true);
  assert.equal(qualifies(s({ essentialFailed: ["a"] })).ok, false);
  assert.equal(qualifies(s({ successRate: 0.69 })).ok, false);
  assert.equal(qualifies(s({ successRate: 0.7 })).ok, true);
  assert.equal(qualifies(s({ successByKind: { style: 0.49 } })).ok, false);
  assert.equal(qualifies(s({ successByKind: { style: 0.5 } })).ok, true);
  assert.equal(qualifies(s({ firstAnswerMsP95: 30001 })).ok, false);
  assert.equal(qualifies(s({ firstAnswerMsP95: 30000 })).ok, true);
  assert.equal(qualifies(s({ answerMsP95: 15001 })).ok, false);
  assert.equal(qualifies(s({ peakRssMb: 2049 })).ok, false);
  assert.equal(qualifies(s({ peakRssMb: 2048 })).ok, true);
});

test("ADR 0081 default model: of those that qualify, the smallest peak RSS; none when none qualifies", () => {
  const all = [s({ key: "a", peakRssMb: 900, successRate: 0.5 }), s({ key: "b", peakRssMb: 1500 }), s({ key: "c", peakRssMb: 1100 })];
  assert.equal(pickDefault(all), "c");
  assert.equal(pickDefault([s({ essentialFailed: ["x"] })]), null);
});
