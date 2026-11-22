// The kinsoku and hanging punctuation of the editors (docs/adr/0090): the
// values Golem resolved from a project's style.toml (`golem kinsoku`), and
// the CSS that wraps the text with them. Golem keeps the rules; Aleph only
// maps its values to WebKit's line-break and hanging-punctuation.
import type { Out } from "./api.ts";
import type { TextEditor } from "./ed/editor.ts";

export type Composition = { kinsoku: "strict" | "loose"; hanging: boolean };
export type Read = { ok: Composition } | { error: string };

/** Golem's defaults: `kinsoku = "strict"`, `hanging-punctuation = false`. */
export const DEFAULT_COMPOSITION: Composition = { kinsoku: "strict", hanging: false };

/** The values of `golem kinsoku`, or what went wrong (an error of style.toml, a golem without the command). */
export const parseKinsoku = (out: Out): Read => {
  if (out.code !== 0) return { error: out.stderr.trim() || `golem kinsoku が終了コード ${out.code} で終わりました` };
  try {
    const j = JSON.parse(out.stdout) as { schema?: unknown; composition?: { kinsoku?: unknown; hangingPunctuation?: unknown } };
    const k = j.composition?.kinsoku;
    const h = j.composition?.hangingPunctuation;
    if (j.schema === 1 && (k === "strict" || k === "loose") && typeof h === "boolean") return { ok: { kinsoku: k, hanging: h } };
  } catch {
    // falls through to the error below
  }
  return { error: "golem kinsoku の出力を読めませんでした" };
};

/** The latest value read; on an error the last one stays, and before any the default (ADR 0090 I1). */
export const resolveComposition = (last: Composition | undefined, read: Read): Composition =>
  "ok" in read ? read.ok : (last ?? DEFAULT_COMPOSITION);

/** Which values an editor takes: its project's, the default, or none for code and settings files. */
export const targetOf = (kind: string, project: string | null): "project" | "default" | null =>
  kind === "gm" && project ? "project" : ["gm", "md", "txt"].includes(kind) ? "default" : null;

/**
 * The CSS of the text. `strict` is WebKit's `line-break: strict`, which kept
 * every prohibition of Golem's strict that was tried
 * (docs/research/2026-11-23-webkit-kinsoku-and-hanging.md). WebKit has no
 * line-break that allows small kana and ー at the line start, so `loose` is
 * WebKit's `loose`, which still keeps them from it (docs/adr/0090 is not done
 * for loose). Hanging is `allow-end`, which hangs 。．、， only when they do
 * not fit, as Golem does.
 */
export const styleOf = (c: Composition | null) =>
  c ? { lineBreak: c.kinsoku, hangingPunctuation: c.hanging ? "allow-end" : "none" } : { lineBreak: "", hangingPunctuation: "" };

/** Gives an editor the values; only its view's style changes (ADR 0090 I4). */
export const applyTo = (t: Pick<TextEditor, "view">, c: Composition | null) => t.view.setComposition(c);
