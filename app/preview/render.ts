// Drawing the previews into an element; shared by the main window and the
// preview windows (docs/adr/0010). Drawing goes into a child of the scrolling
// pane, never onto the pane itself, so its class and scrolling stay.
import { api } from "../api.ts";
import { esc } from "../esc.ts";
import { gmBlocks } from "../gm.ts";
import { icon } from "../icons.ts";
import { markdownHtml } from "../md.ts";
import { ext } from "../path.ts";
import { uiState } from "../uistate.ts";
import { stripRemoteImages } from "./svgimages.ts";

const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", pdf: "application/pdf" };

/** An object URL of a file's bytes. */
export const fileUrl = async (path: string) => URL.createObjectURL(new Blob([await api.readBytes(path)], { type: MIME[ext(path)] ?? "application/octet-stream" }));

/** The child of `pane` drawn into, made once. */
export const surface = (pane: HTMLElement): HTMLElement => {
  const have = pane.querySelector<HTMLElement>(":scope > .pview");
  if (have) return have;
  const el = document.createElement("div");
  el.className = "pview";
  pane.replaceChildren(el);
  return el;
};

/** The text without commands and expressions, when Golem's HTML is not there yet. */
export const plainHtml = (src: string) =>
  gmBlocks(src)
    .map((b) =>
      b.kind === "h"
        ? `<h${Math.min(6, b.level)}>${esc(b.text)}</h${Math.min(6, b.level)}>`
        : b.kind === "p"
          ? `<p>${esc(b.text)}</p>`
          : `<div class="plain-break">改ページ</div>`,
    )
    .join("");

export const loadImages = (el: HTMLElement) =>
  Promise.all(
    [...el.querySelectorAll<HTMLImageElement>("img[data-src]")].map(async (img) => {
      img.src = await fileUrl(img.dataset.src!).catch(() => "");
      img.removeAttribute("data-src");
    }),
  );

export type PlainSection = { title: string; html: string };

export const renderPlain = (pane: HTMLElement, sections: PlainSection[], vertical: boolean, note = "") => {
  const el = surface(pane);
  el.className = `pview plain-stack ${vertical ? "vertical" : ""}`;
  el.innerHTML =
    (note ? `<div class="pnote">${esc(note)}</div>` : "") +
    sections.map((s) => `<div class="plain evaluated ${vertical ? "vertical" : ""}" title="${esc(s.title)}">${s.html}</div>`).join("");
  void loadImages(el);
};

/**
 * How a Markdown sheet becomes HTML with its embeds drawn (docs/adr/0029); set
 * by the wikilinks' mount. `version` changes when an embedded sheet is saved.
 */
export const markdownHook: { expand: ((src: string, path: string) => Promise<string>) | null; version: number } = { expand: null, version: 0 };

export const renderMarkdown = async (pane: HTMLElement, src: string, vertical: boolean, path = "") => {
  const html = markdownHook.expand ? await markdownHook.expand(src, path) : markdownHtml(src);
  const el = surface(pane);
  el.className = `pview plain md ${vertical ? "vertical" : ""}`;
  el.innerHTML = html;
  void loadImages(el);
};

/** SVG as an image: its scripts do not run. */
export const renderSvg = (pane: HTMLElement, src: string) => {
  const el = surface(pane);
  el.className = "pview media";
  const url = URL.createObjectURL(new Blob([src], { type: "image/svg+xml" }));
  el.innerHTML = `<img src="${url}" alt="">`;
};

let mermaidSeq = 0;
export const renderMermaid = async (pane: HTMLElement, src: string) => {
  const el = surface(pane);
  el.className = "pview media";
  const { default: mermaid } = await import("mermaid");
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: document.body.classList.contains("theme-dark") ? "dark" : "default" });
  try {
    const { svg } = await mermaid.render(`mmd${++mermaidSeq}`, src);
    el.innerHTML = stripRemoteImages(svg);
  } catch (e) {
    el.innerHTML = `<pre class="error">${esc(e instanceof Error ? e.message : String(e))}</pre>`;
  }
};

export const renderImage = async (pane: HTMLElement, path: string) => {
  const el = surface(pane);
  el.className = "pview media";
  el.innerHTML = `<img src="${await fileUrl(path)}" alt="">`;
};

/** Pages drawn by shem, one image each, at the zoom (1 is the pane's width). */
export const renderPageImages = (pane: HTMLElement, urls: string[], zoom: number, note = "") => {
  const el = surface(pane);
  el.className = "pview pages";
  el.style.setProperty("--zoom", String(zoom));
  el.innerHTML =
    (note ? `<div class="pnote">${esc(note)}</div>` : "") +
    urls.map((u, i) => `<figure class="page"><img src="${u}" alt=""><figcaption>${i + 1}</figcaption></figure>`).join("");
};

export const renderHint = (pane: HTMLElement, text: string, error = false) => {
  const el = surface(pane);
  el.className = "pview";
  el.innerHTML = error ? `<pre class="error">${esc(text)}</pre>` : `<div class="hint">${esc(text)}</div>`;
};

// ---- zoom, kept in the settings' screen state ----

export const ZOOM_MIN = 0.3;
export const ZOOM_MAX = 4;
export const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));

export const loadZoom = (): number => clampZoom(uiState().get("pageZoom", 1));
export const saveZoom = (z: number) => uiState().set("pageZoom", z);

export const zoomControls = (z: number) =>
  `<span class="zoom"><span class="iconbtn" data-zoom="out" title="縮小">${icon("zoom-out", 14)}</span><span class="zoomv" data-zoom="fit" title="幅に合わせる（100%）">${Math.round(z * 100)}%</span><span class="iconbtn" data-zoom="in" title="拡大">${icon("zoom-in", 14)}</span></span>`;

/** The zoom after a click on the controls, or null when the click was elsewhere. */
export const zoomByClick = (target: HTMLElement, z: number): number | null => {
  const k = target.closest<HTMLElement>("[data-zoom]")?.dataset.zoom;
  if (!k) return null;
  return k === "fit" ? 1 : clampZoom(k === "in" ? z * 1.25 : z / 1.25);
};

/** Pinch (a wheel with ctrl) and ⌘ with the wheel zoom; returns a remover. */
export const onWheelZoom = (el: HTMLElement, get: () => number, set: (z: number) => void) => {
  const f = (e: WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    set(clampZoom(get() * Math.exp(-e.deltaY * 0.01)));
  };
  el.addEventListener("wheel", f, { passive: false });
  return () => el.removeEventListener("wheel", f);
};
