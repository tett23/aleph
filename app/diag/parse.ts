// golem check, lint and preflight with --format json (docs/adr/0015): the
// diagnostics array they write to standard error, its order, and the status
// bar's colour.

export type Severity = "error" | "warning" | "notice" | "info";
export type Diagnostic = {
  code: string;
  severity: Severity;
  message: string;
  span?: { file: string; line: number; column: number; start?: number; end?: number };
  related?: { message?: string; span?: { file: string; line: number; column: number } }[];
  facts?: Record<string, string>;
};

/** The items, or the output itself (raw) when it is not a JSON array. */
export type Result = { items: Diagnostic[]; raw: string | null };

export const parseDiagnostics = (stderr: string): Result => {
  const t = stderr.trim();
  try {
    const v = JSON.parse(t);
    if (Array.isArray(v)) return { items: v as Diagnostic[], raw: null };
  } catch {
    /* not JSON: shown as it is */
  }
  return { items: [], raw: t };
};

const ORDER: Record<Severity, number> = { error: 0, warning: 1, notice: 2, info: 3 };

export const sortDiagnostics = (xs: Diagnostic[]): Diagnostic[] =>
  [...xs].sort(
    (a, b) =>
      (ORDER[a.severity] ?? 9) - (ORDER[b.severity] ?? 9) ||
      (a.span?.file ?? "").localeCompare(b.span?.file ?? "") ||
      (a.span?.line ?? 0) - (b.span?.line ?? 0) ||
      (a.span?.column ?? 0) - (b.span?.column ?? 0),
  );

/** The class of the status item: red for errors (and a run that failed), yellow warnings, blue notices, green otherwise; "" when not run. */
export const statusOf = (r: Result | null): { cls: "" | "ok" | "ng" | "warn" | "note"; count: number } => {
  if (!r) return { cls: "", count: 0 };
  if (r.raw !== null) return { cls: "ng", count: 0 };
  const n = (s: Severity) => r.items.filter((x) => x.severity === s).length;
  const count = n("error") + n("warning") + n("notice");
  return { cls: n("error") ? "ng" : n("warning") ? "warn" : n("notice") ? "note" : "ok", count };
};
