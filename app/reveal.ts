// "Finder で表示" on the tree's rows and on the tabs (docs/adr/0053).
import type { Tab } from "./store.ts";
import type { MenuItem } from "./ui/dom.ts";

/** The file a tab shows: the focused sheet, the plot's plot.csv, or none for an empty tab. */
export const tabTarget = (t: Tab): string | null => (t.plot ? `${t.plot}/plot.csv` : (t.open[t.focus] ?? t.open[0])?.path ?? null);

/** The menu item that shows `path` in Finder; `ic` is its icon's HTML. */
export const revealItems = (path: string, reveal: (path: string) => void, ic = ""): MenuItem[] => [
  { label: "Finder で表示", icon: ic, run: () => reveal(path) },
];
