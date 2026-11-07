// The editor's input without the DOM (docs/adr/0019): beforeinput, composition
// and keydown events turned into transactions of the core. The view reads the
// selection and the DOM's text and passes them in; the tests replay sequences
// recorded in the Tauri WebView through the same code.
import type { Core } from "./core.ts";
import { createIme } from "./ime.ts";
import { inputChange } from "./input.ts";
import type { Text } from "./text.ts";
import { createCore } from "./core.ts";

export type BeforeInput = { inputType: string; data: string | null; isComposing: boolean };
export type KeyDown = { key: string; keyCode: number; isComposing: boolean };
/** The text the DOM has for lines `first`..`last` (1-based) of the document before composing. */
export type ReadDom = (first: number, last: number) => string;

export const createInput = (core: Core) => {
  const ime = createIme();
  const finish = (type: "compositionend" | "blur", data: string, read: ReadDom) => {
    const lines = ime.lines(core.doc());
    if (!lines) return null;
    const dom = read(lines[0], lines[1]);
    const r = ime.feed(type === "blur" ? { type, dom } : { type, data, dom });
    if (!r || "wait" in r) return null;
    if (r.commit) core.apply([r.commit], "input.ime", { anchor: r.caret, head: r.caret });
    else core.select({ anchor: r.caret, head: r.caret });
    return lines;
  };
  return {
    ime,
    composing: () => ime.composing(),
    /** "prevent" when the editor took the event (the DOM is drawn from the core); "allow" when the browser should go on. */
    beforeInput: (e: BeforeInput): "prevent" | "allow" => {
      if (e.isComposing || ime.composing()) return "allow";
      const r = inputChange({ inputType: e.inputType, data: e.data }, core.range(), core.doc());
      if (r && "command" in r) {
        if (r.command === "compose") return "allow";
        if (r.command === "undo") core.undo();
        else core.redo();
        return "prevent";
      }
      if (r) core.apply(r.changes, r.kind, { anchor: r.sel, head: r.sel });
      return "prevent";
    },
    compositionStart: () => ime.start(core.doc(), core.range()),
    /** Takes in the composition; returns the lines that were composed (to draw anew), or null. */
    compositionEnd: (data: string, read: ReadDom) => finish("compositionend", data, read),
    blur: (read: ReadDom) => (ime.composing() ? finish("blur", "", read) : null),
    /** Whether the key belongs to the input method (the editor leaves it alone). */
    keyDown: (e: KeyDown) => ime.swallowKey(e),
  };
};

export type Input = ReturnType<typeof createInput>;

// ---- recorded sequences ----

export type RecordedEvent =
  | { type: "select"; anchor: number; head: number }
  | ({ type: "beforeinput" } & BeforeInput)
  | { type: "input"; inputType?: string; data?: string | null }
  | ({ type: "keydown" } & KeyDown)
  | { type: "compositionstart" }
  | { type: "compositionupdate"; data: string }
  | { type: "compositionend"; data: string; dom: string }
  | { type: "blur"; dom: string };

export type Recorded = { name: string; ua: string; note?: string; initial: string; events: RecordedEvent[]; expected: string; caret?: number };

/** Lines `first`..`last` of `doc` as they are in `dom`, the DOM's full text (the other lines are unchanged). */
export const composedRegion = (doc: Text, dom: string, first: number, last: number) => {
  const lines = dom.split("\n");
  const count = lines.length - doc.lines + (last - first + 1);
  return lines.slice(first - 1, first - 1 + Math.max(1, count)).join("\n");
};

/** Runs a recorded sequence through the editor's input. */
export const replay = (rec: Recorded) => {
  const core = createCore(rec.initial);
  const input = createInput(core);
  for (const e of rec.events) {
    if (e.type === "select") core.select({ anchor: e.anchor, head: e.head });
    else if (e.type === "beforeinput") input.beforeInput(e);
    else if (e.type === "keydown") input.keyDown(e);
    else if (e.type === "compositionstart") input.compositionStart();
    else if (e.type === "compositionend") {
      const doc = core.doc();
      input.compositionEnd(e.data, (a, b) => composedRegion(doc, e.dom, a, b));
    } else if (e.type === "blur") {
      const doc = core.doc();
      input.blur((a, b) => composedRegion(doc, e.dom, a, b));
    }
  }
  return { text: core.text(), caret: core.sel().head };
};

