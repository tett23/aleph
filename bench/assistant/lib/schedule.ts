// Whether a night's run of the assistant benchmark measures (docs/adr/0085).

export type Job = { name: string; conclusion: string | null };
export type Run = { id: number; sha: string; jobs: readonly Job[] };

// The jobs besides the measure jobs that a run must finish for its measurement
// to count
export const FINISHING_JOBS = ["analyze", "budget-measure", "budget-report"] as const;

const succeeded = (j: Job) => j.conclusion === "success";

// A run that finished measuring: every measure job, analyze and both budget
// jobs succeeded (I5)
export const finishedMeasuring = (r: Run) => {
  const measures = r.jobs.filter((j) => j.name === "measure" || j.name.startsWith("measure ("));
  return measures.length > 0 && measures.every(succeeded) && FINISHING_JOBS.every((name) => r.jobs.some((j) => j.name === name && succeeded(j)));
};

// The runs that finished measuring, in the order given (newest first)
export const measuredRuns = (runs: readonly Run[]) => runs.filter(finishedMeasuring);

// A scheduled run skips when main has not moved since the newest run that
// finished measuring (I2); any other event measures (I3)
export const shouldMeasure = (event: string, head: string, lastMeasured: string | null) => event !== "schedule" || lastMeasured !== head;
