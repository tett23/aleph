// Bookmarks of sheets and lines, kept per workspace in .aleph/bookmarks.json
// with paths from the workspace's root (docs/adr/0025).

export type Bookmark = { path: string; line?: number; text?: string };

const same = (a: Bookmark, b: Bookmark) => a.path === b.path && (a.line ?? 0) === (b.line ?? 0);

/** Adds the bookmark, or removes it when the same sheet (or the same line of it) is already there. */
export const toggleBookmark = (list: Bookmark[], b: Bookmark): Bookmark[] =>
  list.some((x) => same(x, b)) ? list.filter((x) => !same(x, b)) : [...list, b];

export const moveBookmark = (list: Bookmark[], from: number, to: number): Bookmark[] => {
  const out = [...list];
  const [b] = out.splice(from, 1);
  out.splice(to, 0, b);
  return out;
};

export const removeBookmark = (list: Bookmark[], i: number): Bookmark[] => list.filter((_, k) => k !== i);

export const parseBookmarks = (text: string): Bookmark[] => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  const items = raw && typeof raw === "object" && Array.isArray((raw as { bookmarks?: unknown }).bookmarks) ? (raw as { bookmarks: unknown[] }).bookmarks : [];
  return items.flatMap((v) => {
    if (!v || typeof v !== "object") return [];
    const o = v as Record<string, unknown>;
    if (typeof o.path !== "string" || !o.path) return [];
    if (o.line === undefined && o.text === undefined) return [{ path: o.path }];
    if (typeof o.line !== "number" || !Number.isInteger(o.line) || o.line < 1 || typeof o.text !== "string") return [];
    return [{ path: o.path, line: o.line, text: o.text }];
  });
};

export const writeBookmarks = (list: Bookmark[]) => JSON.stringify({ bookmarks: list }, null, 2) + "\n";

/** The line (1-based) to go to: the kept number if its text is the same, else the nearest line with that text (the earlier on a tie), else the kept number within the document. */
export const relocate = (lines: string[], kept: number, text: string): number => {
  const n = Math.min(Math.max(1, kept), Math.max(1, lines.length));
  if (lines[n - 1] === text) return n;
  for (let d = 1; d < lines.length; d++) {
    if (n - d >= 1 && lines[n - d - 1] === text) return n - d;
    if (n + d <= lines.length && lines[n + d - 1] === text) return n + d;
  }
  return n;
};

/** A file or a folder renamed (paths from the workspace's root): the bookmarks on it or under it follow. */
export const renameBookmarks = (list: Bookmark[], from: string, to: string): Bookmark[] =>
  list.map((b) => (b.path === from ? { ...b, path: to } : b.path.startsWith(from + "/") ? { ...b, path: to + b.path.slice(from.length) } : b));
