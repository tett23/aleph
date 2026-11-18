// The numbers of one measured configuration (a model at a context length), the
// regression rule of the CI runs, and the rule that picks the default model
// (docs/adr/0081, 既定のモデルの選び方 and 計測を CI で続ける).
import { median } from "./stats.ts";

export type Summary = {
  key: string; // "<model id>@<context>"
  model: string;
  context: number;
  firstAnswerMsP95: number;
  answerMsMedian: number;
  answerMsP95: number;
  peakRssMb: number;
  successRate: number; // 0 to 1
  successByKind: Record<string, number>;
  essentialFailed: string[];
};

export type Metric = "answer-ms-median" | "answer-ms-p95" | "peak-rss-mb" | "success-rate" | "essential";
export type Regression = { key: string; metric: Metric; value: number; baseline: number; consecutive: boolean };

export const HISTORY = 4;
const WORSE = 1.2;
const SUCCESS_DROP = 0.05;

const bigger: [Metric, (s: Summary) => number][] = [
  ["answer-ms-median", (s) => s.answerMsMedian],
  ["answer-ms-p95", (s) => s.answerMsP95],
  ["peak-rss-mb", (s) => s.peakRssMb],
];

// `history` holds the summaries of the previous runs, the most recent first;
// `previous` the regressions found in the most recent of them. With fewer than
// four previous runs of a configuration, nothing about it is judged.
export const regressions = (
  current: readonly Summary[],
  history: readonly (readonly Summary[])[],
  previous: readonly { key: string; metric: string }[],
): Regression[] => {
  const last = history.slice(0, HISTORY);
  const was = (key: string, metric: Metric) => previous.some((p) => p.key === key && p.metric === metric);
  return current.flatMap((s) => {
    const past = last.map((run) => run.find((p) => p.key === s.key)).filter((p): p is Summary => p !== undefined);
    if (last.length < HISTORY || past.length < HISTORY) return [];
    const found: Omit<Regression, "consecutive">[] = [
      ...bigger.flatMap(([metric, get]) => {
        const baseline = median(past.map(get));
        return get(s) >= baseline * WORSE ? [{ key: s.key, metric, value: get(s), baseline }] : [];
      }),
      ...(() => {
        const baseline = median(past.map((p) => p.successRate));
        return s.successRate <= baseline - SUCCESS_DROP + 1e-9 ? [{ key: s.key, metric: "success-rate" as const, value: s.successRate, baseline }] : [];
      })(),
      ...(s.essentialFailed.length > 0 ? [{ key: s.key, metric: "essential" as const, value: s.essentialFailed.length, baseline: 0 }] : []),
    ];
    return found.map((r) => ({ ...r, consecutive: was(r.key, r.metric) }));
  });
};

export type Budgets = { firstAnswerMsP95: number; answerMsP95: number; peakRssMb: number };
// The budgets of the selection rule of docs/adr/0081, kept as they are by
// docs/adr/0086; not the budgets of docs/budgets.md, which differ
export const BUDGETS: Budgets = { firstAnswerMsP95: 30000, answerMsP95: 15000, peakRssMb: 2048 };

export type Judged = { key: string; ok: boolean; reasons: string[] };

// A configuration qualifies when it passes every essential task, 70% of all
// tasks and 50% of the tasks of each kind, and meets the three budgets
export const qualifies = (s: Summary, b: Budgets = BUDGETS): Judged => {
  const reasons = [
    ...(s.essentialFailed.length > 0 ? [`欠かせない課題に落ちた: ${s.essentialFailed.join(", ")}`] : []),
    ...(s.successRate < 0.7 ? [`全体の正解の割合 ${pct(s.successRate)} < 70%`] : []),
    ...Object.entries(s.successByKind).flatMap(([k, r]) => (r < 0.5 ? [`${k} の正解の割合 ${pct(r)} < 50%`] : [])),
    ...(s.firstAnswerMsP95 > b.firstAnswerMsP95 ? [`起動からの答えの p95 ${s.firstAnswerMsP95} ms > ${b.firstAnswerMsP95}`] : []),
    ...(s.answerMsP95 > b.answerMsP95 ? [`答えの p95 ${s.answerMsP95} ms > ${b.answerMsP95}`] : []),
    ...(s.peakRssMb > b.peakRssMb ? [`最大の RSS ${s.peakRssMb} MB > ${b.peakRssMb}`] : []),
  ];
  return { key: s.key, ok: reasons.length === 0, reasons };
};

const pct = (r: number) => `${Math.round(r * 1000) / 10}%`;

// Of the configurations that qualify, the one with the smallest peak RSS
export const pickDefault = (all: readonly Summary[], b: Budgets = BUDGETS): string | null =>
  all
    .filter((s) => qualifies(s, b).ok)
    .slice()
    .sort((x, y) => x.peakRssMb - y.peakRssMb)[0]?.key ?? null;
