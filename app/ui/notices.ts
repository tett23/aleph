// The notifications on the screen (docs/adr/0064): stacked at the bottom right above the
// status bar, timed or sticky, with buttons and ×. Every window has its own; those of the
// other windows (the pages, the plot) also go into the main window's history.
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { esc } from "../esc.ts";
import { h, icon } from "../icons.ts";
import { swallowLatePress } from "./press.ts";
import { createFolds, foldKey, type Fold } from "../notice-fold.ts";
import { createNotifications, type Handle, type Level, type Note, type NotificationEvent, type Notifications, type NotifyOpts } from "../notify.ts";

export const LEVEL_ICON: Record<Level, string> = { info: "info", warning: "triangle-alert", error: "circle-x" };

let model: Notifications | null = null;
let host: HTMLElement | null = null;
const els = new Map<number, HTMLElement>();
/** Whether each long text is folded or open (docs/adr/0111). */
const folds = createFolds();
const FOLD_LINES = 6;
let drawnIds = new Set<number>();

const label = () => {
  try {
    return getCurrentWindow().label;
  } catch {
    return "main";
  }
};

/** This window's notifications. */
export const notifications = (): Notifications => {
  if (model) return model;
  const windowLabel = label();
  const clock = { now: () => Date.now(), set: (fn: () => void, ms: number) => window.setTimeout(fn, ms), clear: (id: number) => clearTimeout(id) };
  if (windowLabel === "main") {
    const main = createNotifications(clock);
    model = main;
    void listen<NotificationEvent>("aleph:notified", (e) => main.receive(e.payload)).catch(() => {});
  } else {
    const instance = crypto.getRandomValues(new Uint32Array(4)).join("-");
    model = createNotifications(clock, {
      origin: `${windowLabel}:${instance}`,
      send: (event) => void emitTo("main", "aleph:notified", event).catch(() => {}),
    });
  }
  model.subscribe(draw);
  return model;
};

export const notify = (o: NotifyOpts): Handle => notifications().notify(o);

/** A failure: an error that stays until closed. */
export const notifyError = (message: string, actions?: NotifyOpts["actions"]) => notify({ message, level: "error", sticky: true, actions });

/** The bar of a progress notification (docs/adr/0078). */
const barHtml = (n: Note) =>
  n.progress
    ? `<div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(n.progress.value * 100)}"><i style="width:${(n.progress.value * 100).toFixed(1)}%"></i></div><div class="cnt">${esc(n.progress.text)}</div>`
    : "";

/** A long text folds to six lines; the underlined text below it opens and folds it (docs/adr/0111). */
const foldHtml = (f: Fold) => (f.long ? `<span class="fold-btn" data-fold>${f.open ? "折りたたむ" : "すべて表示"}</span>` : "");

const noteHtml = (n: Note, f: Fold) =>
  `<span class="ic">${icon(LEVEL_ICON[n.level], 16)}</span><div class="msg${f.long ? (f.open ? " open" : " fold") : ""}">${esc(n.message)}</div><span class="x" data-x title="閉じる">${icon("x", 13)}</span>${foldHtml(f)}${barHtml(n)}${
    n.actions.length ? `<div class="btns">${n.actions.map((a, i) => `<span class="btn${a.primary ? " pri" : ""}" data-a="${i}">${esc(a.label)}</span>`).join("")}</div>` : ""
  }`;

const elOf = (n: Note) => {
  let el = els.get(n.id);
  if (!el) {
    el = h(`<div class="nt lv-${n.level}" data-id="${n.id}"></div>`);
    el.addEventListener("mouseenter", () => notifications().hover(n.id, true));
    el.addEventListener("mouseleave", () => notifications().hover(n.id, false));
    els.set(n.id, el);
  }
  const html = noteHtml(n, folds.of(foldKey(n)));
  if (el.dataset.html !== html) {
    el.innerHTML = html;
    el.dataset.html = html;
  }
  return el;
};

/** The stack, its elements kept by id so the pointer's place over them is kept. */
function draw() {
  if (!host) {
    host = h(`<div class="toasts" role="status" aria-live="polite"></div>`);
    document.body.append(host);
    // taken at mouseup, as the menus are: the mousedown can come late in this window (docs/adr/0058)
    host.addEventListener("mouseup", (e) => {
      if (e.button !== 0) return;
      const t = e.target as HTMLElement;
      if (t.closest("[data-more]")) return notifications().expand(true);
      const id = Number(t.closest<HTMLElement>("[data-id]")?.dataset.id);
      if (!id) return;
      if (t.closest("[data-x]")) return (swallowLatePress(), notifications().dismissByUser(id));
      if (t.closest("[data-fold]")) {
        const n = notifications().shown().notes.find((x) => x.id === id);
        if (n) folds.toggle(foldKey(n));
        return draw();
      }
      const a = t.closest<HTMLElement>("[data-a]")?.dataset.a;
      if (a !== undefined) {
        swallowLatePress();
        notifications().press(id, Number(a));
      }
    });
  }
  const { notes, more } = notifications().shown();
  const keep = new Set(notes.map((n) => n.id));
  for (const [id, el] of els)
    if (!keep.has(id)) {
      el.remove();
      els.delete(id);
    }
  const nodes: HTMLElement[] = [];
  if (more) nodes.push(h(`<div class="more" data-more>ほか ${more} 件の通知</div>`));
  nodes.push(...notes.map(elOf));
  host.querySelector(":scope > .more")?.remove();
  nodes.forEach((n, i) => {
    if (host!.children[i] !== n) host!.insertBefore(n, host!.children[i] ?? null);
  });
  fit(notes);
}

/** Measures the texts drawn, drops the states of the notifications gone, and keeps the stack on the screen (docs/adr/0111). */
function fit(notes: Note[]) {
  const stack = host!;
  const live = new Set([...notifications().history().filter((n) => n.live), ...notes].map(foldKey));
  folds.keep(live);
  for (const n of notes) {
    const el = els.get(n.id);
    const msg = el?.querySelector<HTMLElement>(":scope > .msg");
    if (!el || !msg) continue;
    const line = parseFloat(getComputedStyle(msg).lineHeight) || 18;
    if (folds.measured(foldKey(n), msg.scrollHeight > line * FOLD_LINES + 1)) elOf(n);
  }
  const wasScroll = stack.classList.contains("scroll");
  const scroll = stack.scrollHeight > stack.clientHeight + 1;
  stack.classList.toggle("scroll", scroll);
  const ids = new Set(notes.map((n) => n.id));
  const added = [...ids].some((id) => !drawnIds.has(id));
  drawnIds = ids;
  // the newest is at the bottom: show it when it comes, and when the stack starts to scroll
  if (scroll && (added || !wasScroll)) stack.scrollTop = stack.scrollHeight;
}
