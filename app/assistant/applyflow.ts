// 「適用」 of the assistant's tab (docs/adr/0081 I1 to I4, docs/adr/0088): the edits are checked
// again on the sheet's current text; only when they fit, the step before applying runs (the decision,
// the modal dialogs and the commit of docs/adr/0088). Then the edits go in as one change of the
// editor, the sheet is saved, and the diff tab is shown when Git can show it. The editor, the dialogs
// and Git come in as functions, so node --test can run it.
import { diffText } from "../ed/ime.ts";
import { applyToSheet, type Edit, type Scope } from "./edits.ts";

export type ApplyDeps = {
  /** The sheet's text in its editor now. */
  text: () => string;
  /** The step before applying (prepareApply of docs/adr/0088); `applicable` checks the edits again after a commit. */
  prepare: (applicable: () => boolean) => Promise<"apply" | "cancel" | "unapplicable">;
  /** Puts `after` in place of `before` as one change of the editor, undone with one ⌘Z (I3). */
  change: (before: string, after: string) => void;
  /** Saves the sheet; false when it failed. */
  save: () => Promise<boolean>;
  /** Git can be used and the workspace is a repository. */
  diffAvailable: () => Promise<boolean>;
  /** showDiffAfterApply of docs/adr/0088. */
  showDiff: () => void;
};

export type ApplyResult = { kind: "applied" } | { kind: "cancelled" } | { kind: "unapplicable"; reason: string };

export const applyAnswer = async (d: ApplyDeps, scope: Scope, edits: readonly Edit[]): Promise<ApplyResult> => {
  const first = applyToSheet(d.text(), scope, edits);
  // an edit that does not fit shows its reason, with no dialog (docs/adr/0088)
  if (!first.ok) return { kind: "unapplicable", reason: first.reason };
  const p = await d.prepare(() => applyToSheet(d.text(), scope, edits).ok);
  if (p === "cancel") return { kind: "cancelled" };
  // counted again on the text as it is now: a commit saves the sheets, and the writer may have typed
  const before = d.text();
  const now = applyToSheet(before, scope, edits);
  if (p === "unapplicable" || !now.ok) return { kind: "unapplicable", reason: now.ok ? "書き換えの案が、今のテキストに当てられません" : now.reason };
  d.change(before, now.text);
  if ((await d.save()) && (await d.diffAvailable())) d.showDiff();
  return { kind: "applied" };
};

/** The one replacement turning `before` into `after`, for the editor's one change (I3). */
export const assistantChange = (before: string, after: string): { from: number; to: number; insert: string }[] => {
  const r = diffText(before, after);
  return r ? [r] : [];
};
