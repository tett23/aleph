// Japanese input (IME) in the editor (docs/adr/0019). While composing, the
// browser changes the DOM of the composing lines and the editor neither draws
// them nor applies changes; at the end (or when focus leaves), the lines'
// text in the DOM is compared with their text before, and the difference
// becomes one change. Draws asked for meanwhile wait until then.
import type { Text } from "./text.ts";

export type ImeEvent =
  | { type: "beforeinput"; inputType: string; data: string | null }
  | { type: "input"; dom: string }
  | { type: "compositionupdate"; data: string }
  | { type: "compositionend"; data: string; dom: string }
  | { type: "blur"; dom: string };

export type Commit = { commit: { from: number; to: number; insert: string } | null; caret: number };

const isLow = (s: string, i: number) => {
  const c = s.charCodeAt(i);
  return c >= 0xdc00 && c <= 0xdfff;
};

/** The smallest replacement turning `a` into `b`, kept off the middle of surrogate pairs. */
export const diffText = (a: string, b: string): { from: number; to: number; insert: string } | null => {
  if (a === b) return null;
  let head = 0;
  const max = Math.min(a.length, b.length);
  while (head < max && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < max - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  // a cut must not fall between the halves of a pair
  while (head > 0 && (isLow(a, head) || isLow(b, head))) head--;
  while (tail > 0 && (isLow(a, a.length - tail) || isLow(b, b.length - tail))) tail--;
  return { from: head, to: a.length - tail, insert: b.slice(head, b.length - tail) };
};

export const createIme = () => {
  let on: { baseFrom: number; base: string; sel: { from: number; to: number } } | null = null;
  let justEnded = false;
  let waiting: (() => void)[] = [];
  const finish = (dom: string): Commit => {
    const s = on!;
    on = null;
    justEnded = true;
    const d = diffText(s.base, dom);
    const inserted = dom.length - s.base.length + (s.sel.to - s.sel.from);
    const result: Commit = { commit: d && { from: s.baseFrom + d.from, to: s.baseFrom + d.to, insert: d.insert }, caret: s.sel.from + Math.max(0, inserted) };
    const run = waiting;
    waiting = [];
    run.forEach((f) => f());
    return result;
  };
  return {
    composing: () => on !== null,
    /** compositionstart: remembers the lines the selection covers, as they are before composing. */
    start: (doc: Text, sel: { from: number; to: number }) => {
      const first = doc.lineAt(sel.from);
      const last = doc.lineAt(sel.to);
      on = { baseFrom: first.from, base: doc.slice(first.from, last.to), sel };
      justEnded = false;
    },
    /** The line range (1-based) being composed, which must stay drawn. */
    lines: (doc: Text): [number, number] | null => (on ? [doc.lineAt(on.baseFrom).number, doc.lineAt(on.baseFrom + on.base.length).number] : null),
    feed: (e: ImeEvent): Commit | { wait: true } | null => {
      if (!on) return null;
      if (e.type === "compositionend" || e.type === "blur") return finish(e.dom);
      return { wait: true };
    },
    /** Whether a key should be left alone: Enter and others while composing, and the Enter that committed. */
    swallowKey: (e: { key: string; isComposing: boolean; keyCode: number }) => {
      if (on || e.isComposing) return true;
      if (justEnded && e.keyCode === 229) {
        justEnded = false;
        return true;
      }
      justEnded = false;
      return false;
    },
    /** Runs `f` now, or after the composition ends. */
    whenIdle: (f: () => void) => {
      if (on) waiting.push(f);
      else f();
    },
  };
};

export type Ime = ReturnType<typeof createIme>;
