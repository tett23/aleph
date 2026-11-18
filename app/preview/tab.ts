// What the preview tab shows and when the pages are built again after a save (docs/adr/0087).
// Pure: no DOM and no Tauri here, so that node --test can run it.
import type { PreviewMode } from "../store.ts";

/** What the preview tab shows: the text, the pages, a figure, or a line saying why there is nothing. */
export type PreviewShows = "plain" | "pages" | "figure" | "none" | "empty";

export const NO_PREVIEW = "このシートにはプレビューがありません";
export const PICK_SHEET = "シートを選ぶと、ここにプレビューが出ます";

/** I9: decided by the followed sheet's kind and previewMode alone. */
export const previewShows = (doc: { kind: string } | null, mode: PreviewMode): PreviewShows => {
  if (!doc) return "empty";
  if (doc.kind === "gm") return mode;
  if (doc.kind === "md") return "plain";
  if (doc.kind === "svg" || doc.kind === "mmd") return "figure";
  return "none";
};

/** The line shown in place of a preview. */
export const previewMessage = (x: "none" | "empty") => (x === "none" ? NO_PREVIEW : PICK_SHEET);

/**
 * I10: after a save the pages are built again when the setting is on, the saved sheet is a .gm, and
 * the project has pages built before or the preview tab is open with "pages".
 */
export const rebuildPagesOnSave = (o: { setting: boolean; kind: string; hasPages: boolean; previewTab: boolean; mode: PreviewMode }): boolean =>
  o.setting && o.kind === "gm" && (o.hasPages || (o.previewTab && o.mode === "pages"));
