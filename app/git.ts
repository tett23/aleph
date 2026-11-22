// Decisions shared by the Git features.
export const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export const autosaveMessage = (d: Date) => `Autosave ${ymd(d)}`;

/** Once a day per workspace, when there are changes and the setting is on. */
export const shouldAutoCommit = (o: { today: string; last: string | undefined; changed: boolean; enabled: boolean }) =>
  o.enabled && o.changed && o.last !== o.today;
