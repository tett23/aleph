// Editor callbacks live as long as the tab. Give them a stable document
// whose path follows the sheet, without mutating the store's snapshots.
import type { Doc } from "../store.ts";

export const bindEditorDoc = (initial: Doc) => {
  const doc = { ...initial };
  return { doc, update: (next: Doc) => Object.assign(doc, next) };
};
