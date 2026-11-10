// Small DOM helpers: toast, ask (Tauri's WebView has no window.prompt), confirm and menu.
import { esc } from "../esc.ts";
import { h } from "../icons.ts";
import { notify } from "./notices.ts";

/** An information that goes after a while (docs/adr/0064). */
export const toast = (msg: string) => void notify({ message: msg });

const dialog = (title: string, body: string, ok: string) =>
  h(`<div class="dim"><div class="modal small"><div class="mtitle">${esc(title)}</div>${body}
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

export type MenuItem = { label: string; icon?: string; hint?: string; run: () => void } | "-";

/**
 * Calls `f` for a primary-button press on `el`. Taken at mouseup: under the overlay
 * title bar (the toolbar, the ribbon's top, the panel heads) the mousedown was seen
 * arriving after the mouseup, so no click reached the button that was pressed.
 */
export const onPress = (el: HTMLElement, f: (e: MouseEvent) => void) =>
  el.addEventListener("mouseup", (e) => {
    if (e.button === 0) f(e);
  });

export const menu = (anchor: HTMLElement, items: MenuItem[]) => {
  document.querySelectorAll(".menu").forEach((m) => m.remove());
  const r = anchor.getBoundingClientRect();
  const m = h(`<div class="menu" style="position:fixed;top:${r.bottom + 4}px;left:${Math.max(4, Math.min(r.left, innerWidth - 260))}px"></div>`);
  items.forEach((it) => {
    if (it === "-") return m.append(h("<hr>"));
    const d = h(`<div>${it.icon ?? ""}<span>${esc(it.label)}</span>${it.hint ? `<kbd>${esc(it.hint)}</kbd>` : ""}</div>`);
    d.onmouseup = (e) => {
      if (e.button !== 0) return;
      m.remove();
      it.run();
    };
    m.append(d);
  });
  document.body.append(m);
  // a press anywhere but on the menu or its button closes it
  const close = (e: MouseEvent) => {
    const t = e.target as Node;
    if (m.contains(t) || anchor.contains(t)) return;
    m.remove();
    document.removeEventListener("mouseup", close, true);
  };
  setTimeout(() => document.addEventListener("mouseup", close, true), 0);
};
