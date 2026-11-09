// Building a project from Aleph (docs/adr/0058): golem build's arguments, its
// result, the status item, and one build at a time per project.
import { parseDiagnostics, type Diagnostic } from "./diag/parse.ts";

export type BuildOptions = {
  target: "all" | "pdf" | "html" | "epub" | "text";
  profile: "dev" | "prod";
  marks: "none" | "japanese" | "western";
};

export const TARGETS: BuildOptions["target"][] = ["all", "pdf", "html", "epub", "text"];
export const PROFILES: BuildOptions["profile"][] = ["dev", "prod"];
export const MARKS: BuildOptions["marks"][] = ["none", "japanese", "western"];

export const DEFAULT_OPTIONS: BuildOptions = { target: "all", profile: "dev", marks: "none" };

/** Whether the marks apply: they are the PDF's. */
export const marksApply = (o: BuildOptions) => o.target === "all" || o.target === "pdf";

export const buildArgs = (o: BuildOptions): string[] => [
  "build",
  "--format",
  "json",
  "--no-notices",
  "--profile",
  o.profile,
  ...(o.target === "all" ? [] : ["--target", o.target]),
  ...(o.marks !== "none" && marksApply(o) ? ["--marks", o.marks] : []),
];

const pick = <T extends string>(v: unknown, list: T[], d: T): T => (list.includes(v as T) ? (v as T) : d);

/** ui.buildOptions as kept in config.json: unknown or malformed values are the defaults. */
export const readBuildOptions = (v: unknown): BuildOptions => {
  const r = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return {
    target: pick(r.target, TARGETS, DEFAULT_OPTIONS.target),
    profile: pick(r.profile, PROFILES, DEFAULT_OPTIONS.profile),
    marks: pick(r.marks, MARKS, DEFAULT_OPTIONS.marks),
  };
};

export type BuildResult = { failed: boolean; seconds: number; items: Diagnostic[] };

/** golem build's standard error: the diagnostics, or a failure shown by the output's first 20 lines. */
export const readBuildResult = (code: number, stderr: string, stdout: string): Omit<BuildResult, "seconds"> => {
  const r = parseDiagnostics(stderr);
  if (r.raw === null) return { failed: false, items: r.items };
  const text = (stderr.trim() || stdout.trim()).split("\n").slice(0, 20).join("\n");
  return { failed: true, items: [{ code: "", severity: "error", message: text || `golem build が失敗しました（終了コード ${code}）` }] };
};

/** The status bar's item: null before the first build. */
export const buildStatus = (r: BuildResult | null, running: boolean): { cls: string; text: string } | null => {
  if (running) return { cls: "running", text: "● build" };
  if (!r) return null;
  const has = (s: Diagnostic["severity"]) => r.items.some((d) => d.severity === s);
  return { cls: r.failed || has("error") ? "ng" : has("warning") ? "warn" : "ok", text: `● build ${r.seconds.toFixed(1)} 秒` };
};

/** One run at a time per key; asks while running make one more run after it. */
export const createRunner = (run: (key: string) => Promise<void>) => {
  const state = new Map<string, { busy: boolean; again: boolean }>();
  const go = async (key: string): Promise<void> => {
    const s = state.get(key) ?? { busy: false, again: false };
    state.set(key, s);
    if (s.busy) return void (s.again = true);
    s.busy = true;
    try {
      await run(key);
    } finally {
      s.busy = false;
    }
    if (s.again) {
      s.again = false;
      await go(key);
    }
  };
  return go;
};
