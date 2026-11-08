// The editor of a sheet (docs/adr/0019), in horizontal or vertical writing:
// the core and the view, with the change marks, line numbers, page breaks,
// key bindings, search, diagnostics, and what plugins (the LSP) add.
import { lineMarks } from "../diff.ts";
import { estimatePageBreaks } from "../gm.ts";
import type { Grid } from "../store.ts";
import { filterItems, indent } from "./commands.ts";
import { createCore, type Core, type Tx } from "./core.ts";
import { matchKey } from "./keys.ts";
import { createHighlighter, languageOf } from "./lang.ts";
import { createCompletionList, createSearchPanel, panelHost, popup, type SearchUi } from "./panels.ts";
import { findAll, nearest, replacementOf, selectionMatches, type Match } from "./search.ts";
import type { Range } from "./spans.ts";
import { allSources, clampDiagnostics, diagLines, lineDiagnostics, withSource, type Diag, type Severity } from "./diag.ts";
import { createView, type View } from "./view.ts";

export type { Diag };
export type CompletionItem = { label: string; detail?: string; apply: string };

/** What a plugin (the LSP) adds to an editor. */
export type EditorPlugin = {
  /** Keys tried before the editor's own. */
  keys?: { id?: string; key: string; run: () => boolean }[];
  hover?: (pos: number) => Promise<string | null>;
  /** Completion at a position; `explicit` when asked for with Ctrl-Space. */
  complete?: (pos: number, explicit: boolean) => Promise<{ from: number; items: CompletionItem[] } | null>;
  /** Called with the editor once made; returns a cleanup. */
  attach?: (t: TextEditor) => (() => void) | void;
};

/** The parts of a text editor that features outside it use. */
export type TextEditor = {
  core: Core;
  view: View;
  /** Applies replacements as one undoable step and shows the caret. */
  apply: (rs: { from: number; to?: number; insert: string }[], kind: string) => void;
  setLayer: (name: string, ranges: Range[]) => void;
  /** Sets one source's diagnostics (the LSP's by default); other sources' stay (docs/adr/0030). */
  setDiagnostics: (list: Diag[], source?: string) => void;
  /** The tokenizer's colours, turned off once the server's semantic tokens arrive. */
  setFallbackColors: (on: boolean) => void;
  /** Every source's diagnostics, with 1-based lines and columns, for the problems panel (docs/adr/0055). */
  diagnostics: () => { line: number; col: number; severity: Severity; message: string; source?: string }[];
  /** Runs one of the editor's commands by id (docs/adr/0023); false when it has none by that id. */
  command: (id: string) => boolean;
  /** Whether the editor has a command by that id. */
  hasCommand: (id: string) => boolean;
};

export type Editor = {
  /** The text editor, or null for views that are not text (PDF, images, the plot). */
  edit: TextEditor | null;
  text: () => string;
  setText: (text: string) => void;
  goto: (line: number, col?: number) => void;
  focus: () => void;
  setWidth: (chars: number) => void;
  setInvisibles: (on: boolean) => void;
  setGrid: (g: Grid) => void;
  /** Draws the change marks again; with `reset`, reads HEAD again (after a commit). */
  refreshMarks: (reset?: boolean) => void;
  setVertical: (on: boolean) => void;
  destroy: () => void;
};

export type EditorOptions = {
  parent: HTMLElement;
  kind: string;
  text: string;
  grid: Grid;
  chars: number;
  invisibles: boolean;
  vertical: boolean;
  /** "prose" (body font) or "code". */
  style: "prose" | "code";
  /** The element that scrolls, when several sheets share one pane. */
  scroller?: HTMLElement;
  /** HEAD's text, for the change marks; null when the file is not in HEAD. */
  base: () => Promise<string | null>;
  onChange: (text: string) => void;
  onSave: () => void;
  onFocus?: () => void;
  /** After the caret moves (for the status bar). */
  onCaret?: () => void;
  plugins?: EditorPlugin[];
  /**
   * The app's key bindings (docs/adr/0034), asked before the editor's own
   * table; when given, the table is matched only for Escape (the editor's
   * commands are reached by id through `command`).
   */
  keys?: (e: KeyboardEvent) => boolean;
  /** How the file's paragraphs are separated, for the page break estimates. */
  separator?: () => "blank-line" | "line";
  /** After the diagnostics change (the problems panel, docs/adr/0055). */
  onDiagnostics?: () => void;
};

const HOVER_DELAY = 350;

export const createEditor = (o: EditorOptions): Editor => {
  const core = createCore(o.text);
  const plugins = o.plugins ?? [];
  let grid = o.grid;
  let baseText: string | null | undefined;
  let marksTimer = 0;
  let search: { ui: SearchUi; matches: Match[] } | null = null;
  let completion: { list: ReturnType<typeof createCompletionList>; from: number } | null = null;
  let completeTimer = 0;
  let completeSeq = 0;
  let diagSources = new Map<string, Diag[]>();
  let selMatchKey = "";

  const view: View = createView({
    parent: o.parent,
    core,
    highlighter: createHighlighter(languageOf(o.kind)),
    style: o.style,
    chars: o.chars,
    vertical: o.vertical,
    invisibles: o.invisibles,
    scroller: o.scroller,
    onKey: (e) => onKey(e),
    onFocus: o.onFocus,
    onBlur: () => closeCompletion(),
    onUpdate: (tx) => onUpdate(tx),
  });

  // ---- after each change ----

  const onUpdate = (tx: Tx | null) => {
    if (tx) {
      o.onChange(core.text());
      clearTimeout(marksTimer);
      marksTimer = window.setTimeout(() => editor.refreshMarks(), 400);
      if (search) findMatches(false);
      if (tx.kind === "input.type" || (completion && tx.kind === "input.delete")) scheduleComplete(false);
      else closeCompletion();
      updateDiagLines();
    } else if (completion && (core.sel().head < completion.from || core.sel().anchor !== core.sel().head)) closeCompletion();
    // the gutter mark's popup stays while only the selection moves (docs/adr/0054)
    if (tx || hoverMark === null) hideHover();
    updateSelMatches();
    o.onCaret?.();
  };

  /** Other occurrences of a short selection, as CodeMirror's highlightSelectionMatches did. */
  const updateSelMatches = () => {
    const key = `${core.selectedText()}@${core.range().from}`;
    if (key === selMatchKey) return;
    selMatchKey = key;
    const ranges = selectionMatches(core.text(), core.range()).map((m) => ({ ...m, cls: "ed-selmatch" }));
    if (!ranges.length && !core.layer("selmatch").length) return;
    core.setLayer("selmatch", ranges);
    view.layersChanged();
  };

  // ---- keys ----

  const selectAll = () => {
    core.select({ anchor: 0, head: core.doc().length });
    view.syncSelection();
    o.onCaret?.();
  };

  const KEYS: { id?: string; key: string; run: () => boolean }[] = [
    { id: "file.save", key: "Mod-s", run: () => (o.onSave(), true) },
    { id: "editor.undo", key: "Mod-z", run: () => (core.undo() && view.revealCaret(), true) },
    { id: "editor.redo", key: "Mod-Shift-z", run: () => (core.redo() && view.revealCaret(), true) },
    { key: "Mod-y", run: () => (core.redo() && view.revealCaret(), true) },
    { id: "editor.selectAll", key: "Mod-a", run: () => (selectAll(), true) },
    { id: "editor.find", key: "Mod-f", run: () => (openSearch(), true) },
    { id: "editor.complete", key: "Ctrl-Space", run: () => (scheduleComplete(true), true) },
    { id: "editor.indent", key: "Tab", run: () => (doIndent(1), true) },
    { id: "editor.outdent", key: "Shift-Tab", run: () => (doIndent(-1), true) },
    {
      key: "Escape",
      run: () => {
        if (completion) return closeCompletion(), true;
        if (hoverEl) return hideHover(), true;
        if (search) return closeSearch(), true;
        return false;
      },
    },
  ];

  const onKey = (e: KeyboardEvent): boolean => {
    if (completion && completion.list.key(e)) return true;
    if (o.keys) {
      if (o.keys(e)) return true;
      return KEYS.some((k) => k.key === "Escape" && matchKey(k.key, e) && k.run());
    }
    for (const p of plugins) for (const k of p.keys ?? []) if (matchKey(k.key, e) && k.run()) return true;
    for (const k of KEYS) if (matchKey(k.key, e) && k.run()) return true;
    return false;
  };

  const doIndent = (dir: 1 | -1) => {
    const rs = indent(core.doc(), core.range(), dir);
    if (!rs.length) return;
    // the selection maps through the change, so it keeps covering the same lines
    core.apply(rs, "indent");
    view.syncSelection();
    view.revealCaret();
  };

  // ---- completion ----

  const closeCompletion = () => {
    completion?.list.close();
    completion = null;
    clearTimeout(completeTimer);
  };

  const scheduleComplete = (explicit: boolean) => {
    const p = plugins.find((x) => x.complete);
    if (!p) return;
    clearTimeout(completeTimer);
    completeTimer = window.setTimeout(async () => {
      const seq = ++completeSeq;
      const pos = core.sel().head;
      const r = await p.complete!(pos, explicit).catch(() => null);
      if (seq !== completeSeq || core.sel().head !== pos || view.composing()) return;
      closeCompletion();
      if (!r) return;
      const items = filterItems(r.items, core.doc().slice(r.from, pos));
      const at = view.coordsAt(pos);
      if (!items.length || !at) return;
      completion = {
        from: r.from,
        list: createCompletionList(at, view.isVertical(), items, (i) => {
          const to = core.sel().head;
          closeCompletion();
          core.apply([{ from: r.from, to, insert: i.apply }], "input.complete", { anchor: r.from + i.apply.length, head: r.from + i.apply.length });
          view.revealCaret();
        }),
      };
    }, explicit ? 0 : 120);
  };

  // ---- hover ----

  let hoverEl: HTMLElement | null = null;
  let hoverTimer = 0;
  let hoverSeq = 0;
  // the gutter mark whose line the popup shows (docs/adr/0054)
  let hoverMark: number | null = null;
  const hideHover = () => {
    clearTimeout(hoverTimer);
    hoverSeq++;
    hoverEl?.remove();
    hoverEl = null;
    hoverMark = null;
  };
  const onMouseMove = (e: MouseEvent) => {
    if (hoverMark !== null && hoverMark === markLine(markAt(e.target))) return;
    if (e.buttons) return hideHover();
    if (hoverEl && hoverEl.contains(e.target as Node)) return;
    hideHover();
    const mark = markAt(e.target);
    if (mark) return void (hoverTimer = window.setTimeout(() => showLineDiags(mark), HOVER_DELAY));
    const { clientX: x, clientY: y } = e;
    hoverTimer = window.setTimeout(async () => {
      const seq = hoverSeq;
      const pos = view.posAtCoords(x, y);
      if (pos === null) return;
      // only over the text itself: the character at the position must be near the pointer
      const at = view.coordsAt(pos);
      if (!at || Math.hypot(at.left - x, (at.top + at.bottom) / 2 - y) > 40) return;
      const here = currentDiags().filter((d) => d.from <= pos && pos <= d.to);
      const plugin = plugins.find((p) => p.hover);
      const text = plugin ? await plugin.hover!(pos).catch(() => null) : null;
      if (seq !== hoverSeq || (!here.length && !text)) return;
      const html = [
        ...here.map((d) => `<div class="hover-diag sev-${d.severity}">${escape(d.message)}</div>`),
        ...(text ? [`<div class="hover">${escape(text)}</div>`] : []),
      ].join("");
      hoverEl = popup("ed-hover", at, view.isVertical(), html);
      hoverEl.addEventListener("mouseleave", hideHover);
    }, HOVER_DELAY);
  };
  const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  // the gutter mark: its line's diagnostics, whatever their range (docs/adr/0054)
  // the slot the mark sits in (the line's height, 14 px wide) is the target, not only the 9 px dot
  const markAt = (t: EventTarget | null) => {
    const slot = t instanceof Element ? t.closest(".ed-gut .dg-slot") : null;
    return slot?.querySelector(".dg") ? slot : null;
  };
  const markLine = (mark: Element | null) => Number(mark?.closest<HTMLElement>(".ed-line")?.dataset.line) || null;
  const diagHtml = (d: Diag) => `<div class="hover-diag sev-${d.severity}">${escape(d.message)}</div>`;
  const showLineDiags = (mark: Element) => {
    const n = markLine(mark);
    const list = n ? lineDiagnostics(core.doc(), currentDiags(), n) : [];
    if (!list.length) return;
    hideHover();
    const r = mark.getBoundingClientRect();
    // below the mark in vertical writing (the gutter is above the line), to its lower right in horizontal
    const at = view.isVertical() ? r : new DOMRect(r.right, r.top, 0, r.height);
    hoverEl = popup("ed-hover", at, false, list.map(diagHtml).join(""));
    hoverMark = n;
    hoverEl.addEventListener("mouseleave", (e) => {
      if (markLine(markAt(e.relatedTarget)) !== hoverMark) hideHover();
    });
  };
  // a press on the mark shows them at once and leaves the caret where it is
  view.content.addEventListener(
    "mousedown",
    (e) => {
      const mark = markAt(e.target);
      if (!mark || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      showLineDiags(mark);
    },
    true,
  );
  view.content.addEventListener("mousemove", onMouseMove);
  view.content.addEventListener("mouseleave", (e) => {
    if (!hoverEl?.contains(e.relatedTarget as Node)) hideHover();
  });

  // ---- search ----

  const findMatches = (move: boolean) => {
    if (!search) return;
    const q = search.ui.query();
    search.matches = findAll(core.text(), q);
    const cur = search.matches.findIndex((m) => m.from === core.range().from && m.to === core.range().to);
    core.setLayer(
      "search",
      search.matches.map((m, i) => ({ ...m, cls: i === cur ? "ed-match ed-match-cur" : "ed-match" })),
    );
    view.layersChanged();
    search.ui.setCount(cur + 1, search.matches.length);
    if (move && cur < 0) gotoMatch(1, core.range().from);
  };

  const gotoMatch = (dir: 1 | -1, from = dir > 0 ? core.range().to : core.range().from) => {
    if (!search) return;
    const m = nearest(search.matches, from, dir);
    if (!m) return findMatches(false);
    core.select({ anchor: m.from, head: m.to }, true);
    view.scrollToPos(m.from, true);
    view.syncSelection();
    findMatches(false);
  };

  const openSearch = () => {
    const sel = core.selectedText();
    if (!search) {
      const ui = createSearchPanel(panelHost(view.root), {
        change: () => findMatches(true),
        next: (dir) => gotoMatch(dir),
        replace: () => {
          if (!search) return;
          const q = search.ui.query();
          const { from, to } = core.range();
          const m = search.matches.find((x) => x.from === from && x.to === to);
          if (m) {
            const insert = replacementOf(core.doc().slice(m.from, m.to), q, q.replace);
            core.apply([{ from: m.from, to: m.to, insert }], "replace", { anchor: m.from + insert.length, head: m.from + insert.length });
          }
          findMatches(false);
          gotoMatch(1);
        },
        replaceAll: () => {
          if (!search || !search.matches.length) return;
          const q = search.ui.query();
          const text = core.text();
          core.apply(
            search.matches.map((m) => ({ from: m.from, to: m.to, insert: replacementOf(text.slice(m.from, m.to), q, q.replace) })),
            "replace",
          );
          findMatches(false);
        },
        close: () => closeSearch(),
      });
      search = { ui, matches: [] };
    }
    search.ui.focus(sel && !sel.includes("\n") ? sel : undefined);
    findMatches(false);
  };

  const closeSearch = () => {
    search?.ui.close();
    search = null;
    core.setLayer("search", []);
    view.layersChanged();
    view.focus();
  };

  // ---- diagnostics ----

  const currentDiags = (): Diag[] => core.layer("diag").map((r) => ({ ...(r as Range & Diag), from: r.from, to: r.to }));

  const updateDiagLines = () => view.setDiagLines(diagLines(core.doc(), currentDiags()));

  const text: TextEditor = {
    core,
    view,
    apply: (rs, kind) => {
      core.apply(
        rs.map((r) => ({ from: r.from, to: r.to ?? r.from, insert: r.insert })),
        kind,
      );
      view.revealCaret();
    },
    setLayer: (name, ranges) => {
      core.setLayer(name, ranges);
      view.whenIdle(() => view.layersChanged());
    },
    setDiagnostics: (list, source = "default") => {
      diagSources = withSource(diagSources, source, list);
      core.setLayer("diag", clampDiagnostics(core.doc(), allSources(diagSources)));
      view.whenIdle(() => {
        updateDiagLines();
        view.layersChanged();
        o.onDiagnostics?.();
      });
    },
    setFallbackColors: (on) => view.toggleClass("no-fallback", !on),
    command: (id) => {
      // a plugin's command first (the LSP's ⌘S formats before saving), then the editor's own
      for (const p of plugins) for (const k of p.keys ?? []) if (k.id === id && k.run()) return true;
      const k = KEYS.find((x) => x.id === id);
      return k ? k.run() : false;
    },
    hasCommand: (id) => plugins.some((p) => p.keys?.some((k) => k.id === id)) || KEYS.some((x) => x.id === id),
    diagnostics: () =>
      currentDiags().map((d) => {
        const l = core.doc().lineAt(d.from);
        return { line: l.number, col: d.from - l.from + 1, severity: d.severity, message: d.message, source: d.source };
      }),
  };

  const editor: Editor = {
    edit: text,
    text: () => core.text(),
    setText: (t) => view.whenIdle(() => t !== core.text() && core.setText(t)),
    goto: (line, col = 0) => {
      const l = core.doc().line(Math.max(1, Math.min(core.doc().lines, line)));
      const pos = Math.min(l.to, l.from + col);
      core.select({ anchor: pos, head: pos }, true);
      view.scrollToPos(pos, true);
      view.focus();
      o.onCaret?.();
    },
    focus: () => view.focus(),
    setWidth: (chars) => view.setChars(chars),
    setInvisibles: (on) => view.setInvisibles(on),
    setGrid: (g) => {
      grid = g;
      editor.refreshMarks();
    },
    refreshMarks: async (reset = false) => {
      if (reset || baseText === undefined) baseText = await o.base();
      const t = core.text();
      view.setMarks(lineMarks(baseText, t));
      if (o.kind === "gm") view.setBreaks(estimatePageBreaks(t, grid, o.separator?.() ?? "blank-line"));
    },
    setVertical: (on) => view.setVertical(on),
    destroy: () => {
      clearTimeout(marksTimer);
      closeCompletion();
      hideHover();
      search?.ui.close();
      cleanups.forEach((f) => f());
      view.destroy();
    },
  };
  const cleanups = plugins.flatMap((p) => {
    const c = p.attach?.(text);
    return c ? [c] : [];
  });
  void editor.refreshMarks();
  return editor;
};
