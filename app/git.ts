// What the Git features decide without running git (docs/adr/0011).

export type StatusEntry = { code: string; path: string; from?: string };

/** The local date, YYYY-MM-DD. */
export const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export const autosaveMessage = (d: Date) => `Autosave ${ymd(d)}`;

/** Once a day per workspace, when there are changes and the setting is on. */
export const shouldAutoCommit = (o: { today: string; last: string | undefined; changed: boolean; enabled: boolean }) =>
  o.enabled && o.changed && o.last !== o.today;

/** `git status --porcelain=v1 -z`: NUL-separated entries; a rename is followed by its old path. */
export const parseStatus = (z: string): StatusEntry[] => {
  const parts = z.split("\0");
  const out: StatusEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.length < 4) continue;
    const xy = p.slice(0, 2);
    const e: StatusEntry = { code: xy.trim() === "??" ? "??" : xy.trim()[0], path: p.slice(3) };
    if (xy[0] === "R" || xy[0] === "C") e.from = parts[++i];
    out.push(e);
  }
  return out;
};
