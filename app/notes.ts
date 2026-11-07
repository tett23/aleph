// A sheet's goal, note and checked items, in .aleph/notes.json of its project
// (or of its workspace, outside projects), keyed by the path from that root (docs/adr/0012).

export type SheetMeta = { goal?: number; note: string; done: string[] };
export type Meta = Record<string, SheetMeta>;

export const parseMeta = (text: string): Meta => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {};
  }
  if (!raw || typeof raw !== "object") return {};
  const out: Meta = {};
  for (const [k, v] of Object.entries(raw as Record<string, Record<string, unknown>>)) {
    if (!v || typeof v !== "object") continue;
    // the prototype's first form had several notes
    const notes = Array.isArray(v.notes) ? (v.notes as { text?: string }[]).map((n) => n?.text ?? "").filter(Boolean).join("\n\n") : "";
    const m: SheetMeta = {
      note: typeof v.note === "string" ? v.note : notes,
      done: Array.isArray(v.done) ? v.done.filter((d): d is string => typeof d === "string") : [],
    };
    if (typeof v.goal === "number" && v.goal > 0) m.goal = v.goal;
    out[k] = m;
  }
  return out;
};

const empty = (m: SheetMeta) => !m.note && !m.done.length && !m.goal;

export const writeMeta = (m: Meta): string => JSON.stringify(Object.fromEntries(Object.entries(m).filter(([, v]) => !empty(v))), null, 2) + "\n";

export const metaFor = (m: Meta, key: string): SheetMeta => m[key] ?? { note: "", done: [] };

export const renameKey = (m: Meta, from: string, to: string): Meta => {
  if (!(from in m)) return m;
  const { [from]: v, ...rest } = m;
  return { ...rest, [to]: v };
};

/** The goal set by hand wins; else the plot's planned characters of the sheet. */
export const goalOf = (hand: number | undefined, planned: number | null): { goal: number | null; from: "hand" | "plot" | null } =>
  hand ? { goal: hand, from: "hand" } : planned ? { goal: planned, from: "plot" } : { goal: null, from: null };
