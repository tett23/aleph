// The editor's state without the DOM (docs/adr/0019): the document, the
// selection, the history and the coloured layers. Each edit is a transaction
// that listeners hear with the lines it changed, which the view draws again.
import { applyChanges, changeSet, mapPos, type ChangeSet, type Replace } from "./change.ts";
import { createHistory, type Selection } from "./history.ts";
import type { Range } from "./spans.ts";
import { textOf, type Text } from "./text.ts";
import { changedLines, mapRanges, type LineChange } from "./update.ts";

export type Tx = { before: Text; changes: ChangeSet; lines: LineChange | null; kind: string };

export const createCore = (initial: string, now: () => number = Date.now) => {
  let doc = textOf(initial);
  let sel: Selection = { anchor: 0, head: 0 };
  const history = createHistory();
  const layers = new Map<string, Range[]>();
  const listeners: ((tx: Tx) => void)[] = [];
  const clamp = (s: Selection): Selection => ({ anchor: Math.max(0, Math.min(doc.length, s.anchor)), head: Math.max(0, Math.min(doc.length, s.head)) });

  const commit = (before: Text, changes: ChangeSet, kind: string, after: Text, next: Selection) => {
    doc = after;
    sel = clamp(next);
    for (const [k, v] of layers) layers.set(k, mapRanges(v, changes));
    const tx: Tx = { before, changes, lines: changedLines(before, changes), kind };
    listeners.forEach((f) => f(tx));
  };

  const core = {
    doc: () => doc,
    text: () => doc.toString(),
    sel: () => sel,
    range: () => ({ from: Math.min(sel.anchor, sel.head), to: Math.max(sel.anchor, sel.head) }),
    selectedText: () => doc.slice(Math.min(sel.anchor, sel.head), Math.max(sel.anchor, sel.head)),
    /** Sets the selection; with `seal`, the next typing starts a new history step (the caret jumped). */
    select: (s: Selection, seal = false) => {
      sel = clamp(s);
      if (seal) history.seal();
    },
    /** Applies replacements of the current document as one transaction; returns false when nothing changed. */
    apply: (rs: Replace[], kind: string, next?: Selection): boolean => {
      const changes = changeSet(rs, doc.length);
      if (!changes.parts.length) return false;
      const before = doc;
      const after = applyChanges(doc, changes);
      const selAfter = next ?? { anchor: mapPos(changes, sel.anchor), head: mapPos(changes, sel.head) };
      history.record({ changes, before, time: now(), kind, selBefore: sel }, selAfter);
      commit(before, changes, kind, after, selAfter);
      return true;
    },
    setText: (text: string) => core.apply([{ from: 0, to: doc.length, insert: text }], "set", { anchor: 0, head: 0 }),
    undo: (): boolean => {
      const before = doc;
      const r = history.undo(doc);
      if (!r) return false;
      commit(before, r.changes, "undo", r.doc, r.sel ?? { anchor: mapPos(r.changes, sel.head), head: mapPos(r.changes, sel.head) });
      return true;
    },
    redo: (): boolean => {
      const before = doc;
      const r = history.redo(doc);
      if (!r) return false;
      commit(before, r.changes, "redo", r.doc, r.sel ?? { anchor: mapPos(r.changes, sel.head), head: mapPos(r.changes, sel.head) });
      return true;
    },
    setLayer: (name: string, ranges: Range[]) => void layers.set(name, ranges),
    layer: (name: string): Range[] => layers.get(name) ?? [],
    listen: (f: (tx: Tx) => void) => {
      listeners.push(f);
      return () => void listeners.splice(listeners.indexOf(f), 1);
    },
  };
  return core;
};

export type Core = ReturnType<typeof createCore>;
