// Undo and redo (docs/adr/0019): changes with their inverses, typing within
// 500 ms grouped into one step, other kinds of change (formatting, drops) alone.
import { applyChanges, composeChanges, invertChanges, type ChangeSet } from "./change.ts";
import type { Text } from "./text.ts";

export type Selection = { anchor: number; head: number };
export type Edit = { changes: ChangeSet; before: Text; time: number; kind: string; selBefore?: Selection };
type Step = { changes: ChangeSet; before: Text; after: Text; time: number; kind: string; selBefore?: Selection; selAfter?: Selection };

const GROUP_MS = 500;
const GROUPED = new Set(["input.type", "input.delete"]);

export const createHistory = () => {
  const done: Step[] = [];
  let undone: Step[] = [];
  return {
    record: (e: Edit, selAfter?: Selection) => {
      if (!e.changes.parts.length) return;
      const after = applyChanges(e.before, e.changes);
      const last = done[done.length - 1];
      undone = [];
      if (last && GROUPED.has(e.kind) && last.kind === e.kind && e.time - last.time < GROUP_MS && last.after.toString() === e.before.toString()) {
        done[done.length - 1] = { ...last, changes: composeChanges(last.changes, e.changes, last.before), after, time: e.time, selAfter };
        return;
      }
      done.push({ changes: e.changes, before: e.before, after, time: e.time, kind: e.kind, selBefore: e.selBefore, selAfter });
    },
    /** The text before the last step, and the selection then; null when nothing is left. */
    undo: (doc: Text): { doc: Text; changes: ChangeSet; sel?: Selection } | null => {
      const s = done.pop();
      if (!s) return null;
      undone.push(s);
      const changes = invertChanges(s.changes, s.before);
      return { doc: applyChanges(doc, changes), changes, sel: s.selBefore };
    },
    redo: (doc: Text): { doc: Text; changes: ChangeSet; sel?: Selection } | null => {
      const s = undone.pop();
      if (!s) return null;
      done.push(s);
      return { doc: applyChanges(doc, s.changes), changes: s.changes, sel: s.selAfter };
    },
    /** Breaks the grouping, so the next typing starts a new step (after a caret jump). */
    seal: () => {
      const last = done[done.length - 1];
      if (last) last.time = -Infinity;
    },
  };
};

export type History = ReturnType<typeof createHistory>;
