// ADR 0066: select the sheet paths as the tree shows them, independently of click order.
import { kindOf } from "./workspace.ts";

export const selectedGmInTreeOrder = (shown: string[], selected: string[]): string[] | null => {
  if (!selected.length || selected.some((path) => kindOf(path) !== "gm" || !shown.includes(path))) return null;
  return shown.filter((path) => selected.includes(path));
};
