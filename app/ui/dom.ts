// Small DOM helpers: toast, ask (Tauri's WebView has no window.prompt), confirm and menu.
import { esc } from "../esc.ts";
import { h } from "../icons.ts";
import { menuBounds, menuPosition } from "./menu-position.ts";
import { notify } from "./notices.ts";
import { swallowLatePress } from "./press.ts";

/** An information that goes after a while (docs/adr/0064). */
export const toast = (msg: string) => void notify({ message: msg });

const dialog = (title: string, body: string, ok: string) =>
  h(`<div class="dim"><div class="dialog small"><div class="mtitle">${esc(title)}</div>${body}
     <div class="mbuttons"><span class="btn" data-x>やめる</span><span class="btn pri" data-ok>${esc(ok)}</span></div></div></div>`);

/** A one-line question. Resolves to the text, or null when cancelled. */
export const ask = (title: string, value = ""): Promise<string | null> =>
  new Promise((resolve) => {
    const dim = dialog(title, `<input class="field wide" value="${esc(value)}">`, "OK");
    const input = dim.querySelector("input")!;
    const done = (v: string | null) => (dim.remove(), resolve(v));
    dim.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      if (t === dim || t.closest("[data-x]")) done(null);
      if (t.closest("[data-ok]")) done(input.value.trim() || null);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) done(input.value.trim() || null);
      if (e.key === "Escape") done(null);
    });
    document.body.append(dim);
    input.focus();
    input.select();
  });

/** A yes or no question. */
export const confirmDialog = (title: string, ok = "OK"): Promise<boolean> =>
  new Promise((resolve) => {
    const dim = dialog(title, "", ok);
    dim.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      if (t === dim || t.closest("[data-x]")) (dim.remove(), resolve(false));
      if (t.closest("[data-ok]")) (dim.remove(), resolve(true));
    });
    document.body.append(dim);
  });

export type MenuItem = { label: string; icon?: string; hint?: string; disabled?: boolean; run: () => void } | "-";

/**
 * Calls `f` for a primary-button press on `el`. Taken at mouseup: under the overlay
 * title bar (the toolbar, the ribbon's top, the panel heads) the mousedown was seen
 * arriving after the mouseup, so no click reached the button that was pressed.
 */
export const onPress = (el: HTMLElement, f: (e: MouseEvent) => void) =>
  el.addEventListener("mouseup", (e) => {
    if (e.button === 0) f(e);
  });

let closeMenu: (() => void) | undefined;

export const menu = (anchor: HTMLElement, items: MenuItem[]) => {
  closeMenu?.();
  const m = h(`<div class="menu"></div>`);
  const viewport = window.visualViewport;

  const place = () => {
    const bounds = menuBounds(viewport
      ? { left: viewport.offsetLeft, top: viewport.offsetTop, width: viewport.width, height: viewport.height }
      : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight });
    m.style.minWidth = `min(220px, ${bounds.width}px)`;
    m.style.maxWidth = `${bounds.width}px`;
    m.style.maxHeight = `${bounds.height}px`;
    const { left, top } = menuPosition(anchor.getBoundingClientRect(), m.getBoundingClientRect(), bounds);
    m.style.left = `${left}px`;
    m.style.top = `${top}px`;
  };
  const onOutsidePress = (e: MouseEvent) => {
    const target = e.target as Node;
    if (m.contains(target) || anchor.contains(target)) return;
    close();
  };
  const close = () => {
    m.remove();
    document.removeEventListener("mouseup", onOutsidePress, { capture: true });
    window.removeEventListener("resize", place);
    viewport?.removeEventListener("resize", place);
    viewport?.removeEventListener("scroll", place);
    closeMenu = undefined;
  };

  items.forEach((it) => {
    if (it === "-") return m.append(h("<hr>"));
    const d = h(`<div${it.disabled ? ' aria-disabled="true"' : ""}>${it.icon ?? ""}<span>${esc(it.label)}</span>${it.hint ? `<kbd>${esc(it.hint)}</kbd>` : ""}</div>`);
    d.onmouseup = (e) => {
      if (e.button !== 0 || it.disabled) return;
      close();
      it.run();
    };
    m.append(d);
  });
  m.style.overflow = "auto";
  document.body.append(m);
  place();
  closeMenu = close;
  document.addEventListener("mouseup", onOutsidePress, { capture: true });
  window.addEventListener("resize", place);
  viewport?.addEventListener("resize", place);
  viewport?.addEventListener("scroll", place);
};

/** A question with several answers (docs/adr/0063): the index chosen, or null when cancelled. The last is the main one. */
export const choiceDialog = (title: string, message: string, options: string[]): Promise<number | null> =>
  new Promise((resolve) => {
    const dim = h(`<div class="dim"><div class="dialog small choice"><div class="mtitle">${esc(title)}</div>${message ? `<div class="mmsg">${esc(message)}</div>` : ""}
      <div class="mbuttons"><span class="btn" data-x>やめる</span>${options.map((o, i) => `<span class="btn${i === options.length - 1 ? " pri" : ""}" data-i="${i}">${esc(o)}</span>`).join("")}</div></div></div>`);
    const done = (v: number | null) => (dim.remove(), swallowLatePress(), resolve(v));
    // taken at mouseup: in this window a click was seen not to arrive on the first press
    onPress(dim, (e) => {
      const t = e.target as HTMLElement;
      if (t === dim || t.closest("[data-x]")) return done(null);
      const i = t.closest<HTMLElement>("[data-i]")?.dataset.i;
      if (i !== undefined) done(Number(i));
    });
    document.body.append(dim);
  });
