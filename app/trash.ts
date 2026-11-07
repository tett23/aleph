// The trash (docs/adr/0033): what a deletion records so it can be undone (the
// chapters taken out of manifest.toml, the notes taken out of notes.json), and
// the entries kept 30 days. Pure, so that node --test can run it.
import type { RemovedChapter } from "./manifest.ts";
import type { Meta } from "./notes.ts";

export type Entry = {
  /** The folder's name under trash/: time and a number. */
  id: string;
  original: string;
  /** Milliseconds since the epoch. */
  deletedAt: number;
  workspace: string;
  kind: "sheet" | "folder" | "project";
  chapters: { project: string; removed: RemovedChapter[] } | null;
  notes: { root: string; removed: Meta } | null;
};

export const KEEP_DAYS = 30;

/** The meta with the keys taken out, and what was taken. */
export const removeNotes = (meta: Meta, keys: string[]): { meta: Meta; removed: Meta } => ({
  meta: Object.fromEntries(Object.entries(meta).filter(([k]) => !keys.includes(k))),
  removed: Object.fromEntries(Object.entries(meta).filter(([k]) => keys.includes(k))),
});

/** The removed notes put back under their (maybe new) keys, never over one already there. */
export const restoreNotes = (meta: Meta, removed: Meta, keyOf: (key: string) => string): Meta => {
  const out = { ...meta };
  for (const [k, v] of Object.entries(removed)) {
    const to = keyOf(k);
    if (!(to in out)) out[to] = v;
  }
  return out;
};

/** The entries deleted at least `days` ago. */
export const expired = (entries: Entry[], now: number, days = KEEP_DAYS): Entry[] => entries.filter((e) => now - e.deletedAt >= days * 86_400_000);

const isStr = (v: unknown): v is string => typeof v === "string";

export const parseEntry = (text: string): Entry | null => {
  let r: Partial<Entry>;
  try {
    r = JSON.parse(text);
  } catch {
    return null;
  }
  if (!r || typeof r !== "object" || !isStr(r.id) || !isStr(r.original) || typeof r.deletedAt !== "number" || !isStr(r.workspace)) return null;
  const kind = r.kind === "folder" || r.kind === "project" ? r.kind : "sheet";
  const chapters = r.chapters && isStr(r.chapters.project) && Array.isArray(r.chapters.removed) ? r.chapters : null;
  const notes = r.notes && isStr(r.notes.root) && r.notes.removed && typeof r.notes.removed === "object" ? r.notes : null;
  return { id: r.id, original: r.original, deletedAt: r.deletedAt, workspace: r.workspace, kind, chapters, notes };
};

const pad = (n: number) => String(n).padStart(2, "0");

/** A new entry's id: the local time and a number that keeps it apart from others in the same second. */
export const entryId = (d: Date, n: number) =>
  `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${n}`;
