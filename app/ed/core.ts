// The editor's state without the DOM (docs/adr/0019). A state (the document,
// the selection and the coloured layers) is an immutable value; a transaction
// applies a change to a state and makes a new one. The core keeps the current
// state and the history, and tells listeners each transaction with the lines it
// changed, which the view draws again.
import { applyChanges, changeSet, mapPos, type ChangeSet, type Replace } from "./change.ts";
import { createHistory, type Selection } from "./history.ts";
import type { Range } from "./spans.ts";
import { textOf, type Text } from "./text.ts";
import { changedLines, mapRanges, type LineChange } from "./update.ts";

export type EditorState = { readonly doc: Text; readonly sel: Selection; readonly layers: ReadonlyMap<string, Range[]> };
export type Tx = { before: Text; changes: ChangeSet; lines: LineChange | null; kind: string };

export const initialState = (text: string): EditorState => ({ doc: textOf(text), sel: { anchor: 0, head: 0 }, layers: new Map() });

const clampSel = (doc: Text, s: Selection): Selection => ({
  anchor: Math.max(0, Math.min(doc.length, s.anchor)),
  head: Math.max(0, Math.min(doc.length, s.head)),
});

export const withSelection = (state: EditorState, sel: Selection): EditorState => ({ ...state, sel: clampSel(state.doc, sel) });

export const withLayer = (state: EditorState, name: string, ranges: Range[]): EditorState => ({ ...state, layers: new Map(state.layers).set(name, ranges) });

/** Applies a change set to a state: the new state, with the selection given or mapped, and the layers mapped. */
export const applyTx = (state: EditorState, changes: ChangeSet, kind: string, next?: Selection): { state: EditorState; tx: Tx } => {
  const doc = applyChanges(state.doc, changes);
  const sel = next ?? { anchor: mapPos(changes, state.sel.anchor), head: mapPos(changes, state.sel.head) };
  const layers = new Map([...state.layers].map(([k, v]) => [k, mapRanges(v, changes)] as const));
  return { state: { doc, sel: clampSel(doc, sel), layers }, tx: { before: state.doc, changes, lines: changedLines(state.doc, changes), kind } };
};

/** Applies replacements of the state's document as one transaction. */
export const transact = (state: EditorState, rs: Replace[], kind: string, next?: Selection) => applyTx(state, changeSet(rs, state.doc.length), kind, next);

export const createCore = (initial: string, now: () => number = Date.now) => {
  let state = initialState(initial);
  const history = createHistory();
  const listeners: ((tx: Tx) => void)[] = [];

  const commit = (r: { state: EditorState; tx: Tx }) => {
    state = r.state;
    listeners.forEach((f) => f(r.tx));
  };

  const core = {
    state: () => state,
    doc: () => state.doc,
    text: () => state.doc.toString(),
    sel: () => state.sel,
    range: () => ({ from: Math.min(state.sel.anchor, state.sel.head), to: Math.max(state.sel.anchor, state.sel.head) }),
    selectedText: () => state.doc.slice(core.range().from, core.range().to),
    /** Sets the selection; with `seal`, the next typing starts a new history step (the caret jumped). */
    select: (s: Selection, seal = false) => {
      state = withSelection(state, s);
      if (seal) history.seal();
    },
    /** Applies replacements of the current document as one transaction; returns false when nothing changed. */
    apply: (rs: Replace[], kind: string, next?: Selection): boolean => {
      const r = transact(state, rs, kind, next);
      if (!r.tx.changes.parts.length) return false;
      history.record({ changes: r.tx.changes, before: state.doc, time: now(), kind, selBefore: state.sel }, r.state.sel);
      commit(r);
      return true;
    },
    setText: (text: string) => core.apply([{ from: 0, to: state.doc.length, insert: text }], "set", { anchor: 0, head: 0 }),
    undo: (): boolean => {
      const r = history.undo(state.doc);
      if (!r) return false;
      commit(applyTx(state, r.changes, "undo", r.sel ?? { anchor: mapPos(r.changes, state.sel.head), head: mapPos(r.changes, state.sel.head) }));
      return true;
    },
    redo: (): boolean => {
      const r = history.redo(state.doc);
      if (!r) return false;
      commit(applyTx(state, r.changes, "redo", r.sel ?? { anchor: mapPos(r.changes, state.sel.head), head: mapPos(r.changes, state.sel.head) }));
      return true;
    },
    setLayer: (name: string, ranges: Range[]) => void (state = withLayer(state, name, ranges)),
    layer: (name: string): Range[] => state.layers.get(name) ?? [],
    listen: (f: (tx: Tx) => void) => {
      listeners.push(f);
      return () => void listeners.splice(listeners.indexOf(f), 1);
    },
  };
  return core;
};

export type Core = ReturnType<typeof createCore>;
