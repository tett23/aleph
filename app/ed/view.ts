// The editor's view (docs/adr/0019): one contenteditable element whose lines
// are blocks of spans, drawn only near the viewport, in either writing mode.
// Input comes in through beforeinput and composition events and goes to the
// core; the browser moves the caret, and the selection is read back from it.
import type { Core, Tx } from "./core.ts";
import type { Severity } from "./diag.ts";
import { domToOffset, domWalk, lineText, nearestLine, offsetToDom, regionText } from "./dompos.ts";
import { blockViewport, clampPoint, createHeights, estimateSize, renderRange, scrollTarget as targetStart, type Heights } from "./heights.ts";
import { createInput } from "./control.ts";
import type { Highlighter } from "./lang.ts";
import { invisibleRanges, lineSpans, specialRanges, type Range } from "./spans.ts";
import { linesOfRanges, movedLine, mustLines as mustLinesOf } from "./update.ts";

export type LineMark = "add" | "mod" | "del";
export type { Severity };

export type ViewOptions = {
  parent: HTMLElement;
  core: Core;
  highlighter: Highlighter;
  /** "prose" or "code": the font and how lines are estimated. */
  style: "prose" | "code";
  chars: number;
  vertical: boolean;
  invisibles: boolean;
  /** The element that scrolls, when it is not the editor itself (several sheets in one pane). */
  scroller?: HTMLElement;
  /** Keys first offered to the editor; return true when handled. */
  onKey?: (e: KeyboardEvent) => boolean;
  onFocus?: () => void;
  onBlur?: () => void;
  /** After each transaction and each selection change. */
  onUpdate?: (tx: Tx | null) => void;
};

/** Margin of lines drawn beyond each side of the viewport, in pixels along the block axis. */
const MARGIN = 1200;
const BREAK_SIZE = 24;
/** The layers drawn into the lines, in order: later ones nest inside earlier ones' spans. */
const LAYERS = ["st", "link", "search", "selmatch", "diag"];

const walk = domWalk;
/** A block the browser put inside a line while composing (a line break typed into the composition). */
const isBlock = (n: Node) => n instanceof HTMLElement && n.tagName === "DIV";
const isBreak = (n: Node) => n instanceof HTMLElement && n.tagName === "BR";

type Unit = { line: number; el: HTMLElement; brk: HTMLElement | null; key: string };

const el = (tag: string, cls: string, editable?: boolean) => {
  const e = document.createElement(tag);
  e.className = cls;
  if (editable === false) e.contentEditable = "false";
  return e;
};

export const createView = (o: ViewOptions) => {
  const { core, highlighter } = o;
  const root = el("div", `ed ${o.style}`);
  const scrollEl = el("div", "ed-scroll");
  const content = el("div", "ed-content");
  content.contentEditable = "true";
  content.spellcheck = false;
  content.setAttribute("autocapitalize", "off");
  content.setAttribute("autocorrect", "off");
  content.setAttribute("translate", "no");
  content.setAttribute("role", "textbox");
  content.setAttribute("aria-multiline", "true");
  scrollEl.append(content);
  root.append(scrollEl);
  o.parent.append(root);
  const scroller = () => o.scroller ?? scrollEl;

  let vertical = o.vertical;
  let invisibles = o.invisibles;
  let marks = new Map<number, LineMark>();
  let breaks = new Map<number, number>();
  let diagLines = new Map<number, Severity>();
  let destroyed = false;
  const input = createInput(core);
  const ime = input.ime;
  const units = new Map<number, Unit>();
  const gaps: HTMLElement[] = [];
  let perLine = { chars: 40, size: 28, inline: 0 };
  let heights: Heights = createHeights([]);
  let layerCache: Map<string, Map<number, Range[]>> | null = null;

  const setClasses = () => {
    root.classList.toggle("vertical", vertical);
    root.classList.toggle("inv", invisibles);
    root.style.setProperty("--chars", String(o.chars));
  };
  setClasses();

  // ---- sizes along the block axis ----

  const blockSize = (r: DOMRect) => (vertical ? r.width : r.height);

  const readMetrics = () => {
    const cs = getComputedStyle(content);
    const fs = parseFloat(cs.fontSize) || 16;
    const lh = parseFloat(cs.lineHeight) || fs * 1.75;
    const inline = vertical ? content.clientHeight : content.clientWidth;
    const charW = o.style === "prose" ? fs : fs * 0.6;
    perLine = { chars: Math.max(1, Math.floor((inline || o.chars * fs) / charW)), size: lh, inline };
  };
  const estimate = (n: number) => estimateSize(core.doc().line(n).text.length, perLine.chars, perLine.size) + (breaks.has(n - 1) ? BREAK_SIZE : 0);
  const rebuildHeights = () => {
    readMetrics();
    const doc = core.doc();
    heights = createHeights(Array.from({ length: doc.lines }, (_, i) => estimate(i + 1)));
  };

  // ---- drawing ----

  const layersOf = (): Map<string, Map<number, Range[]>> => {
    if (layerCache) return layerCache;
    layerCache = new Map(LAYERS.map((k) => [k, linesOfRanges(core.doc(), core.layer(k))]));
    return layerCache;
  };

  const gutterOf = (n: number) => {
    const g = el("span", "ed-gut", false);
    const m = marks.get(n - 1);
    const d = diagLines.get(n);
    g.innerHTML = `<span class="chg-slot">${m ? `<span class="chg chg-${m}"></span>` : ""}</span><span class="ln">${n}</span><span class="dg-slot">${d ? `<span class="dg dg-${d}"></span>` : ""}</span>`;
    return g;
  };

  const buildLine = (n: number, text: string, spans: ReturnType<typeof lineSpans>) => {
    const line = el("div", "ed-line");
    line.dataset.line = String(n);
    line.append(gutterOf(n));
    if (!text) line.append(document.createElement("br"));
    else
      for (const s of spans) {
        const t = document.createTextNode(text.slice(s.from, s.to));
        if (!s.cls.length) line.append(t);
        else {
          const sp = document.createElement("span");
          sp.className = s.cls.join(" ");
          sp.append(t);
          line.append(sp);
        }
      }
    // the end-of-line mark is drawn by CSS, not as an element: an element at the end of the line would
    // give the DOM a caret position after it, which WebKit draws at the far edge of the line
    if (invisibles && n < core.doc().lines) line.dataset.eol = "";
    if (!text) line.classList.add("empty");
    return line;
  };

  const unitFor = (n: number): Unit => {
    const doc = core.doc();
    const text = doc.line(n).text;
    const ls = layersOf();
    const layers: Range[][] = [highlighter.tokens(doc, n).map((t) => ({ ...t })), ...LAYERS.map((k) => ls.get(k)!.get(n) ?? []), specialRanges(text)];
    if (invisibles) layers.push(invisibleRanges(text));
    const spans = lineSpans(text, layers);
    const page = breaks.get(n - 1);
    const key = `${text}\u0000${spans.map((s) => `${s.from}-${s.to}:${s.cls.join(".")}`).join(",")}\u0000${marks.get(n - 1) ?? ""}${diagLines.get(n) ?? ""}${page ?? ""}${invisibles ? "i" : ""}${n === doc.lines ? "l" : ""}`;
    const have = units.get(n);
    if (have && have.key === key) return have;
    const brk = page ? Object.assign(el("div", "page-break", false), { textContent: `改ページ（見積もり）　${page - 1} → ${page}` }) : null;
    const u = { line: n, el: buildLine(n, text, spans), brk, key };
    units.set(n, u);
    return u;
  };

  const gapAt = (i: number, size: number) => {
    const g = gaps[i] ?? (gaps[i] = el("div", "ed-gap", false));
    g.style.blockSize = `${Math.max(0, size)}px`;
    return g;
  };

  /** Puts `nodes` as the children of `content`, moving only what is out of place. */
  const reconcile = (nodes: Node[]) => {
    let cur = content.firstChild;
    for (const n of nodes) {
      if (cur === n) cur = cur.nextSibling;
      else content.insertBefore(n, cur);
    }
    while (cur) {
      const next = cur.nextSibling;
      content.removeChild(cur);
      cur = next;
    }
  };

  /** The viewport along the block axis, from the start of the lines. */
  const viewport = () => blockViewport(vertical, scroller().getBoundingClientRect(), (gaps[0] ?? content).getBoundingClientRect());

  const mustLines = () => mustLinesOf(core.doc(), core.sel(), ime.lines(core.doc())).concat(extraMust);
  let extraMust: number[] = [];

  let drawPending = false;
  const draw = () => {
    if (destroyed) return;
    if (ime.composing()) {
      if (!drawPending) {
        drawPending = true;
        ime.whenIdle(() => queueMicrotask(() => ((drawPending = false), draw())));
      }
      return;
    }
    const doc = core.doc();
    if (heights.count() !== doc.lines) rebuildHeights();
    const vp = viewport();
    const ranges = renderRange(heights, vp.start, vp.size, MARGIN, mustLines());
    // the first line in view and where it is, kept in place while sizes change
    const anchorLine = heights.lineAt(Math.max(0, vp.start));
    const anchorBefore = heights.offsetOf(anchorLine) - vp.start;
    const nodes: Node[] = [];
    const drawn = new Set<number>();
    let next = 0;
    ranges.forEach((r, i) => {
      nodes.push(gapAt(i, heights.offsetOf(r.from) - heights.offsetOf(next)));
      for (let k = r.from; k <= r.to; k++) {
        const u = unitFor(k + 1);
        if (u.brk) nodes.push(u.brk);
        nodes.push(u.el);
        drawn.add(k + 1);
      }
      next = r.to + 1;
    });
    nodes.push(gapAt(ranges.length, heights.total() - heights.offsetOf(next)));
    gaps.length = ranges.length + 1;
    for (const k of units.keys()) if (!drawn.has(k)) units.delete(k);
    reconcile(nodes);
    // measure what was drawn; the gaps follow
    let changed = false;
    for (const n of drawn) {
      const u = units.get(n)!;
      const size = blockSize(u.el.getBoundingClientRect()) + (u.brk ? blockSize(u.brk.getBoundingClientRect()) : 0);
      if (Math.abs(size - heights.size(n - 1)) > 0.5) {
        heights.set(n - 1, size);
        changed = true;
      }
    }
    if (changed) {
      next = 0;
      ranges.forEach((r, i) => {
        gapAt(i, heights.offsetOf(r.from) - heights.offsetOf(next));
        next = r.to + 1;
      });
      gapAt(ranges.length, heights.total() - heights.offsetOf(next));
      const delta = heights.offsetOf(anchorLine) - vp.start - anchorBefore;
      if (Math.abs(delta) > 0.5 && vp.start > 0) scrollBy(delta);
    }
    if (hasFocus()) writeSelection();
  };

  const scrollBy = (delta: number) => {
    const s = scroller();
    if (vertical) s.scrollLeft -= delta;
    else s.scrollTop += delta;
  };

  // ---- the selection between the core and the DOM ----

  const lineEl = (n: Node | null): HTMLElement | null => {
    for (let x: Node | null = n; x && x !== content; x = x.parentNode) if (x instanceof HTMLElement && x.classList.contains("ed-line")) return x;
    return null;
  };

  /** The document position of a DOM position inside the content, or null. */
  const posOfDom = (node: Node, offset: number): number | null => {
    const doc = core.doc();
    let line = lineEl(node);
    if (!line && node === content) {
      // between children of the content (WebKit puts the caret there after some clicks): the nearest drawn line
      const kids = [...content.childNodes];
      const near = nearestLine(
        kids.map((k) => k instanceof HTMLElement && k.classList.contains("ed-line")),
        offset,
      );
      if (!near) return null;
      const l = doc.line(Number((kids[near.index] as HTMLElement).dataset.line));
      return near.end ? l.to : l.from;
    }
    if (!line) {
      // inside a gap or a page break: the start of the next drawn line
      let x: Node | null = node;
      while (x && x.parentNode !== content) x = x.parentNode;
      for (let y = x?.nextSibling ?? null; y; y = y.nextSibling) if (y instanceof HTMLElement && y.classList.contains("ed-line")) return doc.line(Number(y.dataset.line)).from;
      return null;
    }
    const l = doc.line(Number(line.dataset.line));
    return l.from + Math.min(l.text.length, domToOffset(walk, line as Node, node, offset));
  };

  /** The DOM position of a document position, when its line is drawn. */
  const domOfPos = (pos: number): { node: Node; offset: number } | null => {
    const doc = core.doc();
    const l = doc.lineAt(pos);
    const u = units.get(l.number);
    if (!u) return null;
    if (!l.text) {
      // after the gutter, before the end-of-line mark and the <br>
      const kids = [...u.el.childNodes];
      const at = kids.findIndex((k) => !(k instanceof HTMLElement && k.classList.contains("ed-gut")));
      return { node: u.el, offset: at < 0 ? kids.length : at };
    }
    return offsetToDom(walk, u.el as Node, pos - l.from);
  };

  const writeSelection = () => {
    const s = document.getSelection();
    if (!s) return;
    const { anchor, head } = core.sel();
    const a = domOfPos(anchor);
    const h = domOfPos(head);
    if (!a || !h) return;
    if (s.anchorNode === a.node && s.anchorOffset === a.offset && s.focusNode === h.node && s.focusOffset === h.offset) return;
    s.setBaseAndExtent(a.node, a.offset, h.node, h.offset);
  };

  const readSelection = (): { anchor: number; head: number } | null => {
    const s = document.getSelection();
    if (!s || !s.anchorNode || !s.focusNode || !content.contains(s.anchorNode) || !content.contains(s.focusNode)) return null;
    const anchor = posOfDom(s.anchorNode, s.anchorOffset);
    const head = posOfDom(s.focusNode, s.focusOffset);
    return anchor === null || head === null ? null : { anchor, head };
  };

  const syncFromDom = (seal: boolean) => {
    const r = readSelection();
    if (!r) return;
    const cur = core.sel();
    if (r.anchor === cur.anchor && r.head === cur.head) return;
    core.select(r, seal);
    o.onUpdate?.(null);
  };

  const onSelectionChange = () => {
    if (ime.composing() || destroyed) return;
    const s = document.getSelection();
    if (!s || !s.anchorNode || !content.contains(s.anchorNode)) return;
    // a selection we wrote reads back as the core has it, and changes nothing
    syncFromDom(true);
    const head = core.doc().lineAt(core.sel().head).number - 1;
    if (!units.has(head + 1)) draw();
  };

  // ---- applying transactions ----

  const onTx = (tx: Tx) => {
    layerCache = null;
    if (tx.lines) {
      const { from, removed, added } = tx.lines;
      highlighter.changed(from, removed, added);
      readMetrics();
      heights.splice(
        from - 1,
        removed,
        Array.from({ length: added }, (_, i) => estimate(from + i)),
      );
      // only the changed lines are drawn anew; the lines after them keep their elements under their new numbers
      const kept = [...units.values()].flatMap((u) => {
        const n = movedLine(u.line, tx.lines!);
        return n === null ? [] : [{ u, n }];
      });
      units.clear();
      for (const { u, n } of kept) {
        if (n !== u.line) {
          u.line = n;
          u.el.dataset.line = String(n);
          const ln = u.el.querySelector(":scope > .ed-gut .ln");
          if (ln) ln.textContent = String(n);
        }
        units.set(n, u);
      }
    }
    draw();
    o.onUpdate?.(tx);
  };
  const unlisten = core.listen(onTx);

  const revealCaret = () => {
    const pos = core.sel().head;
    const r = coordsAt(pos);
    if (!r) return scrollToPos(pos, false);
    revealRect(r);
  };

  const revealRect = (r: { left: number; right: number; top: number; bottom: number }) => {
    const s = scroller();
    const sr = s.getBoundingClientRect();
    const pad = 24;
    if (r.top < sr.top + pad) s.scrollTop -= sr.top + pad - r.top;
    else if (r.bottom > sr.bottom - pad) s.scrollTop += r.bottom - (sr.bottom - pad);
    if (r.left < sr.left + pad) s.scrollLeft -= sr.left + pad - r.left;
    else if (r.right > sr.right - pad) s.scrollLeft += r.right - (sr.right - pad);
  };

  const applyInput = (rs: { from: number; to: number; insert: string }[], kind: string, caret: number) => {
    core.apply(rs, kind, { anchor: caret, head: caret });
    revealCaret();
  };

  // ---- events ----

  const onBeforeInput = (e: InputEvent) => {
    if (e.isComposing || ime.composing()) return;
    syncFromDom(false);
    // a paste carries its text in dataTransfer (insertFromPaste)
    const data = e.data ?? e.dataTransfer?.getData("text/plain") ?? null;
    const before = core.doc();
    if (input.beforeInput({ inputType: e.inputType, data, isComposing: e.isComposing }) === "allow") return;
    e.preventDefault();
    if (core.doc() !== before) revealCaret();
  };

  /** The text the browser now has in lines `a`..`b` being composed (they may have been merged). */
  const composedText = (a: number, b: number): string => {
    const doc = core.doc();
    const first = units.get(a)?.el;
    if (!first) return doc.slice(doc.line(a).from, doc.line(b).to);
    if (!first.isConnected) {
      // WebKit took the line's element away (an empty line, with SKK) and left the committed text loose in
      // the content: read what stands between the lines around the composed ones
      const prev = units.get(a - 1)?.el;
      let x: ChildNode | null = prev?.isConnected ? prev.nextSibling : a === 1 ? content.firstChild : null;
      if (!x) return doc.slice(doc.line(a).from, doc.line(b).to);
      const next = units.get(b + 1)?.el;
      const nodes: Node[] = [];
      for (; x; x = x.nextSibling) {
        const n = x instanceof HTMLElement ? x.dataset.line : undefined;
        if (x === next || (n && Number(n) > b) || (x instanceof HTMLElement && x.classList.contains("ed-gap") && nodes.length)) break;
        nodes.push(x);
      }
      return regionText(walk, nodes, isBlock, isBreak);
    }
    const parts: string[] = [];
    for (let x: Element | null = first; x; x = x.nextElementSibling) {
      const n = (x as HTMLElement).dataset?.line;
      if (x !== first && (x.classList.contains("ed-gap") || (n && Number(n) > b))) break;
      if (x.classList.contains("page-break")) continue;
      parts.push(lineText(walk, x as Node, isBlock));
    }
    return parts.join("\n");
  };

  const endComposition = (type: "compositionend" | "blur", data: string) => {
    const before = core.doc();
    const c = type === "blur" ? input.blur(composedText) : input.compositionEnd(data, composedText);
    if (!c) return;
    // the browser changed these lines: when nothing was committed, they are drawn anew from the core
    if (core.doc() === before) {
      for (let n = c[0]; n <= c[1]; n++) units.delete(n);
      draw();
    }
    revealCaret();
  };

  /**
   * A press in the editor but outside the lines' box (right of the column, past the last line): WebKit
   * would put the caret wherever it likes, so the editor puts it on the nearest line itself.
   */
  const onOutsideDown = (e: MouseEvent) => {
    if (e.button !== 0 || content.contains(e.target as Node)) return;
    e.preventDefault();
    const p = clampPoint(content.getBoundingClientRect(), e.clientX, e.clientY);
    const pos = posAtCoords(p.x, p.y);
    if (pos === null) return;
    content.focus({ preventScroll: true });
    core.select({ anchor: e.shiftKey ? core.sel().anchor : pos, head: pos }, true);
    if (!units.has(core.doc().lineAt(pos).number)) draw();
    writeSelection();
    o.onUpdate?.(null);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (input.keyDown({ key: e.key, isComposing: e.isComposing, keyCode: e.keyCode })) return;
    syncFromDom(false);
    if (o.onKey?.(e)) return e.preventDefault();
  };

  const onCopy = (e: ClipboardEvent, cut: boolean) => {
    const text = core.selectedText();
    if (!text) return;
    e.preventDefault();
    e.clipboardData?.setData("text/plain", text);
    if (cut) {
      const { from, to } = core.range();
      applyInput([{ from, to, insert: "" }], "input.cut", from);
    }
  };

  const listeners: [EventTarget, string, EventListener, AddEventListenerOptions?][] = [
    [content, "beforeinput", onBeforeInput as EventListener],
    [content, "keydown", onKeyDown as EventListener],
    [content, "copy", ((e: ClipboardEvent) => onCopy(e, false)) as EventListener],
    [content, "cut", ((e: ClipboardEvent) => onCopy(e, true)) as EventListener],
    [content, "compositionstart", () => {
      syncFromDom(false);
      input.compositionStart();
    }],
    [content, "compositionend", ((e: CompositionEvent) => endComposition("compositionend", e.data)) as EventListener],
    [content, "focus", () => o.onFocus?.()],
    [content, "blur", () => {
      endComposition("blur", "");
      o.onBlur?.();
    }],
    [content, "dragstart", (e) => e.preventDefault()],
    [scrollEl, "mousedown", onOutsideDown as EventListener],
    [document, "selectionchange", onSelectionChange],
  ];
  for (const [t, k, f, opt] of listeners) t.addEventListener(k, f, opt);

  let frame = 0;
  const onScroll = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      draw();
    });
  };
  let scrollTarget = scroller();
  scrollTarget.addEventListener("scroll", onScroll, { passive: true });
  // a new inline size changes every line's wrapping; a new viewport only what is drawn
  let viewSize = 0;
  const resize = new ResizeObserver(() => {
    const before = perLine.inline;
    readMetrics();
    const vs = viewport().size;
    if (Math.abs(perLine.inline - before) > 1) {
      rebuildHeights();
      units.clear();
    } else if (Math.abs(vs - viewSize) < 1) return;
    viewSize = vs;
    draw();
  });
  resize.observe(content);
  resize.observe(scroller());

  // ---- positions and coordinates ----

  function hasFocus() {
    return document.activeElement === content;
  }

  const coordsAt = (pos: number): DOMRect | null => {
    const d = domOfPos(pos);
    if (!d) return null;
    const r = document.createRange();
    r.setStart(d.node, d.offset);
    r.collapse(true);
    const rect = r.getClientRects()[0] ?? r.getBoundingClientRect();
    if (rect && (rect.width || rect.height)) return rect;
    const u = units.get(core.doc().lineAt(pos).number);
    return u ? u.el.getBoundingClientRect() : null;
  };

  const posAtCoords = (x: number, y: number): number | null => {
    const r = document.caretRangeFromPoint?.(x, y);
    if (r && content.contains(r.startContainer)) {
      const p = posOfDom(r.startContainer, r.startOffset);
      if (p !== null) return p;
    }
    const cr = content.getBoundingClientRect();
    if (x < cr.left - 80 || x > cr.right + 80 || y < cr.top - 80 || y > cr.bottom + 80) return null;
    const origin = (gaps[0] ?? content).getBoundingClientRect();
    const off = vertical ? origin.right - x : y - origin.top;
    return core.doc().line(heights.lineAt(Math.max(0, off)) + 1).from;
  };

  /** Scrolls so that the line of `pos` is in view (centred when asked), drawing it first. */
  const scrollToPos = (pos: number, center = true) => {
    const n = core.doc().lineAt(pos).number - 1;
    extraMust = [n];
    draw();
    const vp = viewport();
    scrollBy(targetStart(heights.offsetOf(n), heights.size(n), vp, center) - vp.start);
    draw();
    extraMust = [];
  };

  /** A thin bar after the line, across the lines' inline size (where a dropped figure goes). */
  const lineEndBar = (n: number) => {
    const u = units.get(n);
    if (!u) return null;
    const r = u.el.getBoundingClientRect();
    const c = content.getBoundingClientRect();
    return vertical ? { left: r.left, top: c.top, width: 2, height: c.height } : { left: c.left, top: r.bottom, width: c.width, height: 2 };
  };

  rebuildHeights();
  draw();

  return {
    root,
    content,
    draw,
    redrawAll: () => {
      units.clear();
      layerCache = null;
      draw();
    },
    layersChanged: () => {
      layerCache = null;
      draw();
    },
    setVertical: (on: boolean) => {
      if (on === vertical) return;
      vertical = on;
      setClasses();
      rebuildHeights();
      units.clear();
      draw();
      // only the editor being written in follows its caret; with several in one pane the others stay put
      if (hasFocus() || !o.scroller) scrollToPos(core.sel().head, true);
    },
    setScroller: (s: HTMLElement | undefined) => {
      scrollTarget.removeEventListener("scroll", onScroll);
      o.scroller = s;
      scrollTarget = scroller();
      scrollTarget.addEventListener("scroll", onScroll, { passive: true });
      draw();
    },
    setChars: (n: number) => {
      o.chars = n;
      setClasses();
    },
    setInvisibles: (on: boolean) => {
      invisibles = on;
      setClasses();
      units.clear();
      draw();
    },
    setMarks: (m: Map<number, LineMark>) => {
      marks = m;
      draw();
    },
    setBreaks: (b: { line: number; page: number }[]) => {
      breaks = new Map(b.map((x) => [x.line, x.page]));
      draw();
    },
    setDiagLines: (d: Map<number, Severity>) => {
      diagLines = d;
      draw();
    },
    toggleClass: (cls: string, on: boolean) => root.classList.toggle(cls, on),
    isVertical: () => vertical,
    composing: () => ime.composing(),
    whenIdle: (f: () => void) => ime.whenIdle(f),
    focus: () => {
      content.focus({ preventScroll: true });
      // writing the selection while composing would end the composition (seen with SKK in WebKit)
      if (!ime.composing()) writeSelection();
    },
    hasFocus,
    /** Writes the core's selection into the DOM (after setting it from outside). */
    syncSelection: () => {
      const n = core.doc().lineAt(core.sel().head).number;
      if (!units.has(n)) draw();
      if (hasFocus() && !ime.composing()) writeSelection();
    },
    revealCaret,
    coordsAt,
    posAtCoords,
    scrollToPos,
    lineEndBar,
    destroy: () => {
      destroyed = true;
      unlisten();
      for (const [t, k, f, opt] of listeners) t.removeEventListener(k, f, opt);
      scrollTarget.removeEventListener("scroll", onScroll);
      resize.disconnect();
      cancelAnimationFrame(frame);
      root.remove();
    },
  };
};

export type View = ReturnType<typeof createView>;
