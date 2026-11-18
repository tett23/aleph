// What the toolbar and the preview tab offer for a sheet (docs/adr/0005, docs/adr/0010, docs/adr/0087).
import type { PreviewMode } from "./store.ts";

/** The previews a kind of sheet has: gm the text and the pages, md, svg and Mermaid one, others none. */
export const previewsFor = (kind: string): PreviewMode[] => (kind === "gm" ? ["plain", "pages"] : ["md", "svg", "mmd"].includes(kind) ? ["plain"] : []);

/** Kinds written as prose, which can be vertical (docs/adr/0019). */
export const PROSE = ["gm", "md", "txt"];

export const canVertical = (kind: string) => PROSE.includes(kind);

/** The label of a preview for a kind: gm has the text and the pages, others a preview. */
export const previewLabel = (kind: string, side: PreviewMode) => (side === "pages" ? "ページ" : kind === "gm" ? "本文" : "プレビュー");

/** Whether the editors are vertical: the switch is on and every open sheet is prose (docs/adr/0019). */
export const verticalOn = (s: { vertical: boolean; open: { kind: string }[] }) => s.vertical && s.open.length > 0 && s.open.every((d) => canVertical(d.kind));
