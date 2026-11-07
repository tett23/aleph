// The recently opened sheets of each workspace, newest first, kept per machine
// in config.json's ui (docs/adr/0026).

export const RECENT_LIMIT = 50;
export type Recent = Record<string, string[]>;

/** Opened sheets (the focused one first) put at the front, without repeats, up to the limit. */
export const pushRecentSheets = (list: string[], opened: string[]) => [...opened, ...list.filter((p) => !opened.includes(p))].slice(0, RECENT_LIMIT);

export const parseRecent = (v: unknown): Recent => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Recent = {};
  for (const [ws, list] of Object.entries(v as Record<string, unknown>))
    if (Array.isArray(list)) out[ws] = list.filter((p): p is string => typeof p === "string").slice(0, RECENT_LIMIT);
  return out;
};

/** A file or folder renamed (absolute paths): it and what is under it take the new path. */
export const renameRecent = (list: string[], from: string, to: string) =>
  list.map((p) => (p === from ? to : p.startsWith(from + "/") ? to + p.slice(from.length) : p));

/** The list without the sheets that no longer exist, as it is written again (docs/adr/0026). */
export const keepExisting = (list: string[], exists: Set<string>) => list.filter((p) => exists.has(p));
