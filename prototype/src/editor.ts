// The CodeMirror editor: gutter with change marks left of the line numbers,
// LSP, page break marks and wrapping at the style's characters per line.
import { autocompletion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, StreamLanguage, syntaxHighlighting, type LanguageSupport } from "@codemirror/language";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { xml } from "@codemirror/legacy-modes/mode/xml";
import { setDiagnostics, type Diagnostic } from "@codemirror/lint";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, RangeSetBuilder, StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  WidgetType,
  drawSelection,
  gutter,
  hoverTooltip,
  highlightSpecialChars,
  keymap,
  MatchDecorator,
  ViewPlugin,
  type ViewUpdate,
  lineNumbers,
  type DecorationSet,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { lineMarks, type LineMark } from "./diff";
import { emetLanguage, estimatePageBreaks, gmLanguage, type Grid } from "./gm";
import { lspFor, uriOf, type LspDiagnostic } from "./lsp";

const highlight = HighlightStyle.define([
  { tag: t.heading, fontWeight: "600" },
  { tag: t.processingInstruction, color: "var(--faint)", fontWeight: "400" },
  { tag: t.keyword, color: "var(--cmd)", fontFamily: "var(--mono)", fontSize: "0.86em" },
  { tag: t.string, color: "var(--expr)", fontFamily: "var(--mono)", fontSize: "0.86em" },
  { tag: t.comment, color: "var(--faint)" },
  { tag: t.escape, color: "var(--faint)" },
  { tag: t.meta, color: "var(--faint)" },
  { tag: t.monospace, fontFamily: "var(--mono)" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "600" },
  { tag: t.typeName, color: "var(--expr)" },
  { tag: t.number, color: "var(--expr)" },
  { tag: t.operator, color: "var(--cmd)" },
  { tag: [t.propertyName, t.attributeName, t.tagName], color: "var(--cmd)" },
]);

const languageOf = (kind: string): Extension => {
  switch (kind) {
    case "gm":
      return gmLanguage;
    case "emet":
      return emetLanguage;
    case "md":
      return markdown() as LanguageSupport;
    case "toml":
      return StreamLanguage.define(toml);
    case "svg":
      return StreamLanguage.define(xml);
    default:
      return [];
  }
};

// ---- change marks in the gutter, left of the line numbers ----
class Mark extends GutterMarker {
  constructor(readonly kind: LineMark) {
    super();
  }
  eq(o: Mark) {
    return o.kind === this.kind;
  }
  toDOM() {
    const d = document.createElement("div");
    d.className = `chg chg-${this.kind}`;
    return d;
  }
}
const marks = { add: new Mark("add"), mod: new Mark("mod"), del: new Mark("del") };
const setMarks = StateEffect.define<Map<number, LineMark>>();
const marksField = StateField.define<Map<number, LineMark>>({
  create: () => new Map(),
  update: (v, tr) => tr.effects.reduce((acc, e) => (e.is(setMarks) ? e.value : acc), v),
});
const changeGutter = gutter({
  class: "cm-change-gutter",
  lineMarker(view, line) {
    const n = view.state.doc.lineAt(line.from).number - 1;
    const k = view.state.field(marksField).get(n);
    return k ? marks[k] : null;
  },
  lineMarkerChange: (u) => u.transactions.some((tr) => tr.effects.some((e) => e.is(setMarks))),
  initialSpacer: () => marks.add,
});

// ---- page break marks ----
class BreakWidget extends WidgetType {
  constructor(readonly page: number) {
    super();
  }
  eq(o: BreakWidget) {
    return o.page === this.page;
  }
  toDOM() {
    const d = document.createElement("div");
    d.className = "page-break";
    d.textContent = `改ページ　${this.page - 1} → ${this.page}`;
    return d;
  }
}
const setBreaks = StateEffect.define<{ line: number; page: number }[]>();
const breaksField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(v, tr) {
    let out = v.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setBreaks)) continue;
      const b = new RangeSetBuilder<Decoration>();
      const seen = new Set<number>();
      for (const { line, page } of e.value) {
        if (line < 0 || line >= tr.state.doc.lines || seen.has(line)) continue;
        seen.add(line);
        const from = tr.state.doc.line(line + 1).from;
        b.add(from, from, Decoration.widget({ widget: new BreakWidget(page), block: true, side: -1 }));
      }
      out = b.finish();
    }
    return out;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ---- invisible characters: spaces, full-width spaces, tabs and line ends ----
class EolWidget extends WidgetType {
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-eol";
    s.textContent = "↵";
    return s;
  }
  eq() {
    return true;
  }
}
const eol = Decoration.widget({ widget: new EolWidget(), side: 1 });
const spaces = new MatchDecorator({
  regexp: /[ \u3000\t]/g,
  decoration: (m) => Decoration.mark({ class: m[0] === " " ? "cm-inv-sp" : m[0] === "\t" ? "cm-inv-tab" : "cm-inv-zsp" }),
});
const invisiblesPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view);
    }
    build(view: EditorView) {
      const b = new RangeSetBuilder<Decoration>();
      const marks = spaces.createDeco(view);
      const items: { from: number; to: number; d: Decoration }[] = [];
      marks.between(0, view.state.doc.length, (from, to, d) => void items.push({ from, to, d }));
      for (const { from, to } of view.visibleRanges) {
        for (let pos = from; pos <= to; ) {
          const line = view.state.doc.lineAt(pos);
          if (line.number < view.state.doc.lines) items.push({ from: line.to, to: line.to, d: eol });
          pos = line.to + 1;
        }
      }
      items.sort((a, c) => a.from - c.from || a.to - c.to);
      items.forEach(({ from, to, d }) => b.add(from, to, d));
      return b.finish();
    }
  },
  { decorations: (v) => v.decorations },
);
const invisibles = (on: boolean): Extension => (on ? [invisiblesPlugin] : []);

/** Kinds written in the body font; the rest use the code font. */
export const PROSE = ["gm", "md", "txt"];

export type EditorOptions = {
  parent: HTMLElement;
  path: string;
  kind: string;
  text: string;
  project: string | null; // the Golem project root, if any
  base: () => Promise<string | null>; // HEAD's text
  grid: Grid;
  chars: number;
  invisibles: boolean;
  onChange: (text: string) => void;
  onSave: () => void;
};

export type Editor = {
  view: EditorView;
  text: () => string;
  setWidth: (chars: number) => void;
  setInvisibles: (on: boolean) => void;
  setGrid: (g: Grid) => void;
  refreshMarks: (resetBase?: boolean) => void;
  goto: (line: number, col?: number) => void;
  destroy: () => void;
};

const widthTheme = (chars: number) =>
  EditorView.theme({ ".cm-content": { maxWidth: `calc(${chars}em + 2px)` } });

export const createEditor = (o: EditorOptions): Editor => {
  const width = new Compartment();
  const inv = new Compartment();
  let grid = o.grid;
  const lsp = o.project && (o.kind === "gm" || o.kind === "emet") ? lspFor(o.project) : null;
  const uri = uriOf(o.path);
  let version = 1;

  const hover = hoverTooltip(async (view, pos) => {
    if (!lsp || lsp.status() !== "ready") return null;
    const line = view.state.doc.lineAt(pos);
    const r = await lsp
      .request<{ contents: unknown } | null>("textDocument/hover", {
        textDocument: { uri },
        position: { line: line.number - 1, character: pos - line.from },
      })
      .catch(() => null);
    if (!r || !r.contents) return null;
    const c = r.contents as { value?: string } | string | { value: string }[];
    const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => x.value).join("\n") : (c.value ?? "");
    if (!text.trim()) return null;
    return {
      pos,
      create: () => {
        const d = document.createElement("div");
        d.className = "hover";
        d.textContent = text.replace(/```\w*\n?/g, "");
        return { dom: d };
      },
    };
  });

  const complete = async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    if (!lsp || lsp.status() !== "ready") return null;
    const word = ctx.matchBefore(/[@\w.-]*/);
    if (!word || (word.from === word.to && !ctx.explicit)) return null;
    const line = ctx.state.doc.lineAt(ctx.pos);
    const r = await lsp
      .request<{ items?: { label: string; detail?: string; insertText?: string }[] } | { label: string }[] | null>(
        "textDocument/completion",
        { textDocument: { uri }, position: { line: line.number - 1, character: ctx.pos - line.from } },
      )
      .catch(() => null);
    const items = Array.isArray(r) ? r : (r?.items ?? []);
    return {
      from: word.from + (word.text.startsWith("@") ? 1 : 0),
      options: items.map((i) => ({ label: i.label, detail: (i as { detail?: string }).detail })),
    };
  };

  let changeTimer = 0;
  let marksTimer = 0;
  let baseText: string | null | undefined;

  const view = new EditorView({
    parent: o.parent,
    state: EditorState.create({
      doc: o.text,
      extensions: [
        changeGutter,
        lineNumbers(),
        marksField,
        breaksField,
        history(),
        drawSelection(),
        highlightSelectionMatches(),
        EditorView.lineWrapping,
        EditorView.editorAttributes.of({ class: PROSE.includes(o.kind) ? "prose" : "code" }),
        languageOf(o.kind),
        syntaxHighlighting(highlight),
        width.of(widthTheme(o.chars)),
        highlightSpecialChars({ addSpecialChars: /[\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/ }),
        inv.of(invisibles(o.invisibles)),
        hover,
        autocompletion({ override: [complete], activateOnTyping: true }),
        keymap.of([
          { key: "Mod-s", run: () => (o.onSave(), true) },
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
        ]),
        EditorView.updateListener.of((u) => {
          if (!u.docChanged) return;
          const text = u.state.doc.toString();
          o.onChange(text);
          clearTimeout(changeTimer);
          changeTimer = window.setTimeout(() => {
            lsp?.notify("textDocument/didChange", {
              textDocument: { uri, version: ++version },
              contentChanges: [{ text }],
            });
          }, 250);
          clearTimeout(marksTimer);
          marksTimer = window.setTimeout(() => editor.refreshMarks(), 400);
        }),
      ],
    }),
  });

  let off = () => {};
  if (lsp) {
    lsp.ready.then(() => {
      lsp.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: o.kind === "gm" ? "golem" : "emet", version, text: o.text },
      });
      off = lsp.onDiagnostics(uri, (ds: LspDiagnostic[]) => {
        const doc = view.state.doc;
        const pos = (p: { line: number; character: number }) => {
          const l = doc.line(Math.min(doc.lines, p.line + 1));
          return Math.min(l.to, l.from + p.character);
        };
        const out: Diagnostic[] = ds.map((d) => ({
          from: pos(d.range.start),
          to: Math.max(pos(d.range.start), pos(d.range.end)),
          severity: d.severity === 1 ? "error" : d.severity === 2 ? "warning" : "info",
          message: `${d.code ? `${d.code}: ` : ""}${d.message}`,
        }));
        view.dispatch(setDiagnostics(view.state, out));
        view.dom.dispatchEvent(new CustomEvent("diagnostics", { detail: out, bubbles: true }));
      });
    });
  }

  const editor: Editor = {
    view,
    text: () => view.state.doc.toString(),
    setWidth: (chars) => view.dispatch({ effects: width.reconfigure(widthTheme(chars)) }),
    setInvisibles: (on) => view.dispatch({ effects: inv.reconfigure(invisibles(on)) }),
    setGrid: (g) => {
      grid = g;
      editor.refreshMarks();
    },
    refreshMarks: async (resetBase = false) => {
      if (resetBase || baseText === undefined) baseText = await o.base();
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
    destroy: () => {
      off();
      lsp?.notify("textDocument/didClose", { textDocument: { uri } });
      view.destroy();
    },
  };
  editor.refreshMarks();
  return editor;
};

/** Tells the LSP that a file was saved, so it may recheck the project. */
export const notifySaved = (project: string | null, path: string) => {
  if (project) lspFor(project).notify("textDocument/didSave", { textDocument: { uri: uriOf(path) } });
};
