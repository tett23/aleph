// Small UI helpers: toast, ask (prompt), menu.
import { esc, h } from "./icons";

export const toast = (msg: string) => {
  const t = h(`<div class="toast">${esc(msg)}</div>`);
  document.body.append(t);
  setTimeout(() => t.remove(), 3200);
};

/** A prompt; Tauri's WebView has no window.prompt. */
export const ask = (title: string, value = ""): Promise<string | null> =>
  new Promise((resolve) => {
    const dim = h(`<div class="dim"><div class="modal" style="width:420px;height:auto;flex-direction:column;padding:18px 20px;gap:12px">
      <div style="font-weight:600">${esc(title)}</div>
      <input class="field" style="width:100%;font-size:13.5px;padding:6px 8px" value="${esc(value)}">
      <div style="display:flex;gap:8px;justify-content:flex-end"><span class="btn" data-x>やめる</span><span class="btn pri" data-ok>OK</span></div>
    </div></div>`);
    const input = dim.querySelector("input")!;
    const done = (v: string | null) => {
      dim.remove();
      resolve(v);
    };
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

export type MenuItem = { label: string; icon?: string; run: () => void } | "-";

export const menu = (anchor: HTMLElement, items: MenuItem[]) => {
  document.querySelectorAll(".menu").forEach((m) => m.remove());
  const r = anchor.getBoundingClientRect();
  const m = h(`<div class="menu" style="position:fixed;top:${r.bottom + 4}px;left:${Math.min(r.left, innerWidth - 240)}px"></div>`);
  items.forEach((it) => {
    if (it === "-") return m.append(h("<hr>"));
    const d = h(`<div>${it.icon ?? ""}<span>${esc(it.label)}</span></div>`);
    d.onclick = () => {
      m.remove();
      it.run();
    };
    m.append(d);
  });
  document.body.append(m);
  setTimeout(() => document.addEventListener("click", () => m.remove(), { once: true }), 0);
};
