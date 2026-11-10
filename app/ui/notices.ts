// The notifications on the screen (docs/adr/0064): stacked at the bottom right above the
// status bar, timed or sticky, with buttons and ×. Every window has its own; those of the
// other windows (the pages, the plot) also go into the main window's history.
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { esc } from "../esc.ts";
import { h, icon } from "../icons.ts";
import { createNotifications, type Handle, type Level, type Note, type Notifications, type NotifyOpts } from "../notify.ts";

export const LEVEL_ICON: Record<Level, string> = { info: "info", warning: "triangle-alert", error: "circle-x" };

let model: Notifications | null = null;
let host: HTMLElement | null = null;
const els = new Map<number, HTMLElement>();

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
  model = createNotifications({ now: () => Date.now(), set: (fn, ms) => window.setTimeout(fn, ms), clear: (id) => clearTimeout(id) });
  model.subscribe(draw);
  // the main window keeps the other windows' notifications in its history
  if (label() === "main") void listen<{ message: string; level: Level }>("aleph:notified", (e) => model!.record(e.payload)).catch(() => {});
  return model;
};

export const notify = (o: NotifyOpts): Handle => {
  const handle = notifications().notify(o);
  if (label() !== "main") void emit("aleph:notified", { message: o.message, level: o.level ?? "info" }).catch(() => {});
  return handle;
};

/** A failure: an error that stays until closed. */
export const notifyError = (message: string, actions?: NotifyOpts["actions"]) => notify({ message, level: "error", sticky: true, actions });

const noteHtml = (n: Note) =>
  `<span class="ic">${icon(LEVEL_ICON[n.level], 16)}</span><div class="msg">${esc(n.message)}</div><span class="x" data-x title="閉じる">${icon("x", 13)}</span>${
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
  const html = noteHtml(n);
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
      if (t.closest("[data-x]")) return notifications().dismiss(id);
      const a = t.closest<HTMLElement>("[data-a]")?.dataset.a;
      if (a !== undefined) notifications().press(id, Number(a));
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
}
