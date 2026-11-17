// The values of docs/budgets.md. The three budgets are three commands, so the
// first --metric run of a commit keeps its values in a file and the next two
// read that file instead of measuring again.

export type Metrics = { firstAnswerMsP95: number; answerMsP95: number; peakRssMb: number };

export const metricOf = (m: Metrics, metric: string) => {
  if (metric === "first-answer-ms-p95") return m.firstAnswerMsP95;
  if (metric === "answer-ms-p95") return m.answerMsP95;
  if (metric === "peak-rss-mb") return m.peakRssMb;
  throw new Error(`unknown metric: ${metric}`);
};

export type MetricKey = { commit: string; dirty: boolean; partial: boolean; model: string; context: number; coldStarts: number };

// The file name of the kept values, or null when they must not be kept: a tree
// with uncommitted changes is not the commit it names, and a run of some of the
// tasks (--only) is not the measurement of the budgets.
export const metricCacheName = (k: MetricKey) =>
  k.dirty || k.partial || k.commit === "" ? null : `aleph-assistant-metrics-${k.commit}-${k.model}-${k.context}-${k.coldStarts}.json`;

export const readMetrics = (text: string): Metrics | null => {
  try {
    const v = JSON.parse(text) as Record<string, unknown>;
    const ok = ["firstAnswerMsP95", "answerMsP95", "peakRssMb"].every((k) => typeof v[k] === "number");
    return ok ? { firstAnswerMsP95: v.firstAnswerMsP95 as number, answerMsP95: v.answerMsP95 as number, peakRssMb: v.peakRssMb as number } : null;
  } catch {
    return null;
  }
};
