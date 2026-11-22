import { characterSpans, type GutterSnapshot } from "../difftab/snapshot.ts";
import { hoverBounds, hoverPosition } from "./diff-hover-placement.ts";

type Rect = { left: number; top: number; right: number; bottom: number };
type Point = { x: number; y: number };
const contains = (r: Rect, p: Point) => p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
const withinBridge = (anchor: Rect, popup: Rect, point: Point) => {
  if (contains(anchor, point) || contains(popup, point)) return true;
  // Span the two vertical edges when they are horizontally separated. For the
  // vertical case transpose the axes. This includes diagonal movement.
  const between = (a: Rect, b: Rect, p: Point) => {
    const gap = b.left - a.right;
    if (gap <= 0 || p.x < a.right || p.x > b.left) return false;
    const t = (p.x - a.right) / gap;
    return p.y >= a.top + t * (b.top - a.top) && p.y <= a.bottom + t * (b.bottom - a.bottom);
  };
  const turn = (r: Rect) => ({ left: r.top, right: r.bottom, top: r.left, bottom: r.right });
  return between(anchor, popup, point) || between(popup, anchor, point) ||
    between(turn(anchor), turn(popup), { x: point.y, y: point.x }) ||
    between(turn(popup), turn(anchor), { x: point.y, y: point.x });
};

const markedSlot = (t: EventTarget | null) => {
  const el = t instanceof Element ? t.closest<HTMLElement>(".ed-gut .chg-slot:has(.chg)") : null;
  return el;
};
const lineOf = (slot: HTMLElement) => Number(slot.closest<HTMLElement>(".ed-line")?.dataset.line) - 1;
const rectOf = (slot: HTMLElement) => slot.querySelector(".chg")!.getBoundingClientRect();

const build = (snapshot: GutterSnapshot) => {
  const hover = document.createElement("div");
  hover.className = "ed-diff-hover";
  hover.style.visibility = "hidden";
  const blocks = (["変更前", "変更後"] as const).map((name) => {
    const panel = document.createElement("section");
    const heading = document.createElement("h2");
    heading.textContent = name;
    const body = document.createElement("div");
    body.className = "ed-diff-scroll";
    body.tabIndex = 0;
    body.setAttribute("aria-label", name);
    panel.append(heading, body);
    hover.append(panel);
    return { heading, body };
  });
  const details = document.createElement("button");
  details.type = "button";
  details.className = "ed-diff-details";
  details.textContent = "詳細";
  hover.append(details);
  for (const run of snapshot.selected) {
    const sections = blocks.map(({ body }) => {
      const pre = document.createElement("pre");
      body.append(pre);
      return pre;
    });
    if (!run.before.length) sections[0].textContent = "なし";
    if (!run.after.length) sections[1].textContent = "なし";
    for (let n = 0; n < Math.max(run.before.length, run.after.length); n++) {
      const before = run.before[n];
      const after = run.after[n];
      const spans = characterSpans(before ?? "", after ?? "");
      for (const [i, text] of [before, after].entries()) {
        if (text === undefined) continue;
        const line = document.createElement("span");
        line.className = "ed-diff-line";
        const skipped = i === 0 ? "added" : "removed";
        for (const span of spans) {
          if (span.kind === skipped) continue;
          if (span.kind === "same") line.append(span.text);
          else {
            const change = document.createElement(span.kind === "removed" ? "del" : "ins");
            change.className = span.kind === "removed" ? "d-word-del" : "d-word-add";
            change.textContent = span.text;
            line.append(change);
          }
        }
        sections[i].append(line);
      }
    }
  }
  return { hover, blocks, details };
};

// This controller never waits on Git. Only marks with a finished comparison
// can start a dwell, and replacing the comparison cancels the dwell.
export const attachDiffHover = (
  content: HTMLElement,
  snapshotAt: (line: number) => GutterSnapshot | null,
  open: (snapshot: GutterSnapshot) => void,
  suppressOtherHover: () => void,
) => {
  const lifecycle = new AbortController();
  const signal = lifecycle.signal;
  let timer = 0;
  let frame = 0;
  let line = -1;
  let point: Point = { x: -1, y: -1 };
  let anchor: Rect | null = null;
  let popup: ReturnType<typeof build> | null = null;
  let layout = "";

  const close = () => {
    clearTimeout(timer);
    cancelAnimationFrame(frame);
    popup?.hover.remove();
    popup = null;
    timer = frame = 0;
    line = -1;
    anchor = null;
    layout = "";
  };
  const slotAtLine = () => content.querySelector<HTMLElement>(`.ed-line[data-line="${line + 1}"] .chg-slot:has(.chg)`);
  const place = () => {
    if (!popup || !anchor) return;
    const slot = slotAtLine();
    if (!slot?.getClientRects().length) return close();
    const vv = window.visualViewport;
    const bounds = hoverBounds(vv
      ? { left: vv.offsetLeft, top: vv.offsetTop, width: vv.width, height: vv.height }
      : { left: 0, top: 0, width: document.documentElement.clientWidth, height: document.documentElement.clientHeight });
    const { hover, blocks, details } = popup;
    anchor = slot.getBoundingClientRect();
    const mark = rectOf(slot);
    const nextLayout = JSON.stringify([bounds, mark.x, mark.y, mark.width, mark.height, vv?.scale]);
    if (layout !== nextLayout) {
      layout = nextLayout;
      hover.style.visibility = "hidden";
      if (bounds) {
        hover.style.width = `${Math.min(560, bounds.width)}px`;
        hover.style.maxHeight = `${Math.min(560, bounds.height)}px`;
        hover.style.setProperty("--diff-frame-inset", `${Math.min(8, bounds.width / 8, bounds.height / 8)}px`);
        hover.classList.remove("whole-scroll");
        if (blocks.some(({ body }) => body.clientHeight < 18) || details.offsetTop + details.offsetHeight > hover.clientHeight) {
          hover.classList.add("whole-scroll");
        }
        const rendered = hover.getBoundingClientRect();
        const pos = hoverPosition(bounds, mark, rendered.width, rendered.height);
        if (pos) {
          hover.style.left = `${pos.left}px`;
          hover.style.top = `${pos.top}px`;
          const fitted = hover.getBoundingClientRect();
          if (fitted.left >= bounds.left - 0.02 && fitted.top >= bounds.top - 0.02 &&
              fitted.right <= bounds.right + 0.02 && fitted.bottom <= bounds.bottom + 0.02) {
            hover.style.visibility = "visible";
          }
        }
      }
    }
    frame = requestAnimationFrame(place);
  };
  const show = () => {
    timer = 0;
    const current = slotAtLine();
    const snapshot = snapshotAt(line);
    if (!current?.getClientRects().length || !snapshot || !contains(current.getBoundingClientRect(), point)) return close();
    popup = build(snapshot);
    popup.hover.addEventListener("mousedown", (e) => {
      if (e.target === popup?.details) e.preventDefault();
    });
    popup.details.onclick = () => { close(); open(snapshot); };
    document.body.append(popup.hover);
    place();
  };

  document.addEventListener("mousemove", (e) => {
    point = { x: e.clientX, y: e.clientY };
    const slot = e.target instanceof Node && content.contains(e.target) ? markedSlot(e.target) : null;
    const next = slot && !e.buttons ? lineOf(slot) : -1;
    if (next >= 0 && snapshotAt(next)) {
      suppressOtherHover();
      if (next === line) return;
      close();
      line = next;
      anchor = slot!.getBoundingClientRect();
      timer = window.setTimeout(show, 300);
    } else if (line >= 0 && (!popup || !anchor || !withinBridge(anchor, popup.hover.getBoundingClientRect(), point))) close();
  }, { signal, capture: true });
  content.addEventListener("mousedown", (e) => {
    const slot = markedSlot(e.target);
    if (!slot || e.button !== 0 || !snapshotAt(lineOf(slot))) return;
    e.preventDefault();
    e.stopPropagation();
  }, { signal, capture: true });
  content.addEventListener("click", (e) => {
    const slot = markedSlot(e.target);
    const snapshot = slot && e.button === 0 && snapshotAt(lineOf(slot));
    if (!snapshot) return;
    e.preventDefault();
    e.stopPropagation();
    close();
    open(snapshot);
  }, { signal, capture: true });
  document.addEventListener("scroll", (e) => {
    if (anchor && e.target instanceof Element && e.target.contains(content)) {
      const r = slotAtLine()?.getBoundingClientRect();
      if (!r || r.x !== anchor.left || r.y !== anchor.top) close();
    }
  }, { signal, capture: true });
  document.addEventListener("mouseleave", close, { signal });
  window.addEventListener("blur", close, { signal });
  // The window's IME gate handles cancellation before it reaches this listener.
  document.addEventListener("keydown", (e) => {
    if (line !== -1 && e.key === "Escape" && !e.isComposing && e.keyCode !== 229) {
      close();
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, { signal, capture: true });
  return { close, destroy: () => { close(); lifecycle.abort(); } };
};

export const isChangeMarker = (target: EventTarget | null) => markedSlot(target) !== null;
