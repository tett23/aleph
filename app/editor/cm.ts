// The CodeMirror editor (docs/adr/0006): gutters with change marks left of the line
// numbers, wrapping at the grid's characters per line, the body and code fonts,
// invisible characters, and estimated page breaks. The LSP plugs in its own
// extensions (docs/adr/0009).
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { HighlightStyle, StreamLanguage, syntaxHighlighting, type StringStream } from "@codemirror/language";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { xml } from "@codemirror/legacy-modes/mode/xml";
import { lintGutter } from "@codemirror/lint";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, RangeSetBuilder, StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  MatchDecorator,
  ViewPlugin,
  WidgetType,
  drawSelection,
  gutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { lineMarks, type LineMark } from "../diff.ts";
import { estimatePageBreaks, startState, tokenizeLine, type LineState, type Token } from "../gm.ts";
import type { Grid } from "../store.ts";
import { PROSE } from "../toolbar.ts";

// ---- languages ----

type GmStream = LineState & { pending: Token[]; at: number };

/** The .gm tokenizer of gm.ts, fed to CodeMirror one line at a time. */
const gmLanguage = StreamLanguage.define<GmStream>({
  name: "gm",
  startState: () => ({ ...startState(), pending: [], at: 0 }),
  copyState: (s) => ({ ...s, stack: [...s.stack], pending: s.pending.map((x) => ({ ...x })) }),
  token(stream: StringStream, state: GmStream) {
    if (stream.sol()) {
      const r = tokenizeLine(stream.string, state);
      state.pending = r.tokens;
      state.stack = r.state.stack;
      state.comment = r.state.comment;
      state.fence = r.state.fence;
    }
    const pos = stream.pos;
    const tk = state.pending.find((x) => x.to > pos);
    if (!tk) {
      stream.skipToEnd();
      return null;
    }
    if (tk.from > pos) {
      stream.pos = tk.from;
      return null;
    }
    stream.pos = tk.to;
    return {
      command: "keyword",
      expression: "string",
      comment: "comment",
      heading: "heading",
      headingMark: "heading processingInstruction",
      escape: "escape",
      fence: "meta",
      code: "monospace",
    }[tk.type];
  },
  blankLine(state) {
    const r = tokenizeLine("", state);
    state.stack = r.state.stack;
    state.comment = r.state.comment;
  },
});

/** .emet is Haskell-like. */
const emetLanguage = StreamLanguage.define<{ c: number }>({
  name: "emet",
  startState: () => ({ c: 0 }),
  token(stream, state) {
    if (state.c > 0) {
      if (stream.match(/^.*?-\}/)) state.c = 0;
      else stream.skipToEnd();
      return "comment";
    }
    if (stream.match("{-")) return (state.c = 1), "comment";
    if (stream.match(/^--.*/)) return "comment";
    if (stream.match(/^"(?:[^"\\]|\\.)*"/)) return "string";
    if (stream.match(/^\d+/)) return "number";
    if (stream.match(/^(pub|inline|block|filter|fn|import|as|where|case|of|let|in|if|then|else|data|type|otherwise)\b/)) return "keyword";
    if (stream.match(/^[A-Z][\w]*/)) return "typeName";
    if (stream.match(/^(::|->|=>|=|\\|\|)/)) return "operator";
    if (stream.match(/^[a-z_][\w']*/)) return "variableName";
    stream.next();
    return null;
  },
});

/** Markdown, enough to read: headings, emphasis, code, lists, quotes, links. */
const mdLanguage = StreamLanguage.define<{ fence: boolean }>({
  name: "md",
  startState: () => ({ fence: false }),
  token(stream, state) {
    if (stream.sol() && stream.match(/^\s*(```|~~~)/)) return (state.fence = !state.fence), stream.skipToEnd(), "meta";
    if (state.fence) return stream.skipToEnd(), "monospace";
    if (stream.sol() && stream.match(/^#{1,6}\s.*/)) return "heading";
    if (stream.sol() && stream.match(/^\s*([-*+]|\d+[.)])\s/)) return "keyword";
    if (stream.sol() && stream.match(/^\s*>/)) return "quote";
    if (stream.match(/^`[^`]*`/)) return "monospace";
    if (stream.match(/^(\*\*|__)(?=\S).*?\S\1/)) return "strong";
    if (stream.match(/^(\*|_)(?=\S).*?\S\1/)) return "emphasis";
    if (stream.match(/^!?\[[^\]]*\]\([^)]*\)/)) return "link";
    stream.next();
    return null;
  },
});

const languageOf = (kind: string): Extension =>
  ({ gm: gmLanguage, emet: emetLanguage, md: mdLanguage, toml: StreamLanguage.define(toml), svg: StreamLanguage.define(xml) })[kind] ?? [];

/** Commands and expressions use the code font inside prose (docs/adr/0006); this stays with semantic tokens. */
const fontStyle = HighlightStyle.define([
  { tag: t.heading, fontWeight: "600" },
  { tag: t.processingInstruction, fontWeight: "400" },
  { tag: [t.keyword, t.string], fontFamily: "var(--mono)", fontSize: "0.86em" },
  { tag: t.monospace, fontFamily: "var(--mono)" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "600" },
]);

/** The fallback tokenizer's colours, replaced by the server's semantic tokens once they arrive (docs/adr/0009). */
const colorStyle = HighlightStyle.define([
  { tag: t.processingInstruction, color: "var(--faint)" },
  { tag: t.keyword, color: "var(--cmd)" },
  { tag: t.string, color: "var(--expr)" },
  { tag: t.comment, color: "var(--faint)" },
  { tag: t.escape, color: "var(--faint)" },
  { tag: t.meta, color: "var(--faint)" },
  { tag: t.quote, color: "var(--text-2)" },
  { tag: t.link, color: "var(--accent)" },
  { tag: t.typeName, color: "var(--expr)" },
  { tag: t.number, color: "var(--expr)" },
  { tag: t.operator, color: "var(--cmd)" },
  { tag: [t.propertyName, t.attributeName, t.tagName], color: "var(--cmd)" },
]);

/** Holds the fallback colours; the LSP empties it for an editor whose semantic tokens arrived. */
export const fallbackColors = new Compartment();
export const fallbackColorExtension: Extension = syntaxHighlighting(colorStyle);

// CodeMirror's markers and widgets are objects inheriting from its prototypes;
// they are made without class syntax (the project does not use classes).

/** A gutter marker drawing `cls`, equal to another with the same `key`. */
export const marker = (key: string, cls: string): GutterMarker =>
  Object.assign(Object.create(GutterMarker.prototype) as GutterMarker, {
    key,
    eq: (o: GutterMarker) => (o as GutterMarker & { key?: string }).key === key,
    toDOM: () => {
      const d = document.createElement("div");
      d.className = cls;
      return d;
    },
  });

/** A widget made by `dom`, equal to another with the same `key`. */
export const widget = (key: string, dom: () => HTMLElement): WidgetType =>
  Object.assign(Object.create(WidgetType.prototype) as WidgetType, {
    key,
    eq: (o: WidgetType) => (o as WidgetType & { key?: string }).key === key,
    toDOM: dom,
  });

// ---- change marks, left of the line numbers ----

const MARKS: Record<LineMark, GutterMarker> = {
  add: marker("add", "chg chg-add"),
  mod: marker("mod", "chg chg-mod"),
  del: marker("del", "chg chg-del"),
};
const setMarks = StateEffect.define<Map<number, LineMark>>();
const marksField = StateField.define<Map<number, LineMark>>({
  create: () => new Map(),
  update: (v, tr) => tr.effects.reduce((acc, e) => (e.is(setMarks) ? e.value : acc), v),
});
const changeGutter = gutter({
  class: "cm-change-gutter",
  lineMarker(view, line) {
    const k = view.state.field(marksField).get(view.state.doc.lineAt(line.from).number - 1);
    return k ? MARKS[k] : null;
  },
  lineMarkerChange: (u) => u.transactions.some((tr) => tr.effects.some((e) => e.is(setMarks))),
  initialSpacer: () => MARKS.add,
});

// ---- page break marks ----

const breakWidget = (page: number) =>
  widget(`break-${page}`, () => {
    const d = document.createElement("div");
    d.className = "page-break";
    d.textContent = `改ページ（見積もり）　${page - 1} → ${page}`;
    return d;
  });
const setBreaks = StateEffect.define<{ line: number; page: number }[]>();
const breaksField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(v, tr) {
    let out = v.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setBreaks)) continue;
      const b = new RangeSetBuilder<Decoration>();
      for (const { line, page } of [...e.value].sort((x, y) => x.line - y.line)) {
        if (line < 0 || line >= tr.state.doc.lines) continue;
        const from = tr.state.doc.line(line + 1).from;
        b.add(from, from, Decoration.widget({ widget: breakWidget(page), block: true, side: -1 }));
      }
      out = b.finish();
    }
    return out;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ---- invisible characters ----

const EOL = Decoration.widget({
  widget: widget("eol", () => {
    const s = document.createElement("span");
    s.className = "cm-eol";
    s.textContent = "↵";
    return s;
  }),
  side: 1,
});
const spaces = new MatchDecorator({
  regexp: /[ \u3000\t]/g,
  decoration: (m) => Decoration.mark({ class: m[0] === " " ? "cm-inv-sp" : m[0] === "\t" ? "cm-inv-tab" : "cm-inv-zsp" }),
});
const invisibleDecorations = (view: EditorView): DecorationSet => {
  const items: { from: number; to: number; d: Decoration }[] = [];
  spaces.createDeco(view).between(0, view.state.doc.length, (from, to, d) => void items.push({ from, to, d }));
  for (const { from, to } of view.visibleRanges)
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos);
      if (line.number < view.state.doc.lines) items.push({ from: line.to, to: line.to, d: EOL });
      pos = line.to + 1;
    }
  items.sort((a, b) => a.from - b.from || a.to - b.to);
  const b = new RangeSetBuilder<Decoration>();
  items.forEach(({ from, to, d }) => b.add(from, to, d));
  return b.finish();
};

const invisiblesPlugin = ViewPlugin.define(
  (view) => {
    const plugin = {
      decorations: invisibleDecorations(view),
      update: (u: ViewUpdate) => {
        if (u.docChanged || u.viewportChanged) plugin.decorations = invisibleDecorations(u.view);
      },
    };
    return plugin;
  },
  { decorations: (v) => v.decorations },
);

// ---- the editor ----

export type EditorOptions = {
  parent: HTMLElement;
  kind: string;
  text: string;
  grid: Grid;
  chars: number;
  invisibles: boolean;
  /** HEAD's text, for the change marks; null when the file is not in HEAD. */
  base: () => Promise<string | null>;
  onChange: (text: string) => void;
  onSave: () => void;
  onFocus?: () => void;
  extensions?: Extension[];
};

export type Editor = {
  view: EditorView | null;
  text: () => string;
  setWidth: (chars: number) => void;
  setInvisibles: (on: boolean) => void;
  setGrid: (g: Grid) => void;
  /** Draws the change marks again; with `reset`, reads HEAD again (after a commit). */
  refreshMarks: (reset?: boolean) => void;
  goto: (line: number, col?: number) => void;
  setText: (text: string) => void;
  destroy: () => void;
};

const widthTheme = (chars: number) => EditorView.theme({ ".cm-content": { maxWidth: `calc(${chars}em + 2px)` } });

export const createEditor = (o: EditorOptions): Editor => {
  const width = new Compartment();
  const inv = new Compartment();
  let grid = o.grid;
  let baseText: string | null | undefined;
  let timer = 0;

  const view = new EditorView({
    parent: o.parent,
    state: EditorState.create({
      doc: o.text,
      extensions: [
        changeGutter,
        lineNumbers(),
        lintGutter(),
        marksField,
        breaksField,
        history(),
        drawSelection(),
        highlightSelectionMatches(),
        EditorView.lineWrapping,
        EditorView.editorAttributes.of({ class: PROSE.includes(o.kind) ? "prose" : "code" }),
        languageOf(o.kind),
        syntaxHighlighting(fontStyle),
        fallbackColors.of(fallbackColorExtension),
        width.of(widthTheme(o.chars)),
        highlightSpecialChars({ addSpecialChars: /[\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/ }),
        inv.of(o.invisibles ? invisiblesPlugin : []),
        keymap.of([{ key: "Mod-s", run: () => (o.onSave(), true) }, indentWithTab, ...defaultKeymap, ...historyKeymap, ...searchKeymap]),
        EditorView.updateListener.of((u) => {
          if (u.focusChanged && u.view.hasFocus) o.onFocus?.();
          if (!u.docChanged) return;
          o.onChange(u.state.doc.toString());
          clearTimeout(timer);
          timer = window.setTimeout(() => editor.refreshMarks(), 400);
        }),
        ...(o.extensions ?? []),
      ],
    }),
  });

  const editor: Editor = {
    view,
    text: () => view.state.doc.toString(),
    setWidth: (chars) => view.dispatch({ effects: width.reconfigure(widthTheme(chars)) }),
    setInvisibles: (on) => view.dispatch({ effects: inv.reconfigure(on ? invisiblesPlugin : []) }),
    setGrid: (g) => {
      grid = g;
      editor.refreshMarks();
    },
    refreshMarks: async (reset = false) => {
      if (reset || baseText === undefined) baseText = await o.base();
      const text = view.state.doc.toString();
      const effects: StateEffect<unknown>[] = [setMarks.of(lineMarks(baseText, text))];
      if (o.kind === "gm") effects.push(setBreaks.of(estimatePageBreaks(text, grid)));
      view.dispatch({ effects });
    },
    goto: (line, col = 0) => {
      const l = view.state.doc.line(Math.max(1, Math.min(view.state.doc.lines, line)));
      const pos = Math.min(l.to, l.from + col);
      view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
      view.focus();
    },
    setText: (text) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }),
    destroy: () => {
      clearTimeout(timer);
      view.destroy();
    },
  };
  void editor.refreshMarks();
  return editor;
};
