// Diagnostics in the editor (docs/adr/0019): where they are drawn and which
// mark each line's gutter gets.
import type { Text } from "./text.ts";

export type Severity = "error" | "warning" | "info" | "hint";
export type Diag = { from: number; to: number; severity: Severity; message: string; source?: string };

const RANK: Record<Severity, number> = { error: 4, warning: 3, info: 2, hint: 1 };

/** Each line's (1-based) most severe diagnostic. */
export const diagLines = (doc: Text, diags: Diag[]): Map<number, Severity> => {
  const m = new Map<number, Severity>();
  for (const d of diags) {
    const n = doc.lineAt(d.from).number;
    const have = m.get(n);
    if (!have || RANK[d.severity] > RANK[have]) m.set(n, d.severity);
  }
  return m;
};

/** Diagnostics kept inside the text, as ranges to draw; one at a point underlines the character after it (not a line break). */
export const clampDiagnostics = (doc: Text, list: Diag[]): (Diag & { cls: string })[] => {
  const len = doc.length;
  return list.map((d) => {
    const from = Math.min(Math.max(0, d.from), len);
    const to = Math.max(from, Math.min(d.to, len));
    const point = to === from && from < len && doc.slice(from, from + 1) !== "\n";
    return { ...d, from, to: point ? from + 1 : to, cls: `ed-diag diag-${d.severity}` };
  });
};
