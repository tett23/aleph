// What the toolbar offers for a sheet (docs/adr/0005, docs/adr/0010).
import type { SidePane } from "./store.ts";

/** The previews a kind of sheet can show beside the editor. */
export const previewsFor = (kind: string): SidePane[] =>
  kind === "gm" ? ["none", "plain", "pages"] : ["md", "svg", "mmd"].includes(kind) ? ["none", "plain"] : [];

/** Kinds written as prose, which can be vertical (docs/adr/0019). */
export const PROSE = ["gm", "md", "txt"];

export const canVertical = (kind: string) => PROSE.includes(kind);

/** The label of a preview for a kind: gm has the text and the pages, others a preview. */
export const previewLabel = (kind: string, side: SidePane) =>
  side === "none" ? "原稿のみ" : side === "pages" ? "ページ" : kind === "gm" ? "本文" : "プレビュー";

/** The preview actually shown: the chosen one if the kind has it, else none. */
export const effectiveSide = (kind: string, side: SidePane): SidePane => (previewsFor(kind).includes(side) ? side : "none");

/** Whether the editors are vertical: the switch is on and every open sheet is prose (docs/adr/0019). */
export const verticalOn = (s: { vertical: boolean; open: { kind: string }[] }) => s.vertical && s.open.length > 0 && s.open.every((d) => canVertical(d.kind));
