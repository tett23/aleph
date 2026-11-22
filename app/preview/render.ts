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
import { createPreviewUpdates, limitPosition, positionOf, type PreviewTarget } from "./update.ts";

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

export type PlainSection = { title: string; html: string };

export const preparePlain = (pane: HTMLElement, sections: PlainSection[], vertical: boolean) =>
  prepare(pane, (staging) => {
    const el = surface(staging);
    el.className = `pview plain-stack ${vertical ? "vertical" : ""}`;
    el.innerHTML = sections.map((s) => `<div class="plain evaluated ${vertical ? "vertical" : ""}" title="${esc(s.title)}">${s.html}</div>`).join("");
  }, vertical);

/**
 * How a Markdown sheet becomes HTML with its embeds drawn (docs/adr/0029); set
 * by the wikilinks' mount. `version` changes when an embedded sheet is saved.
 */
export const markdownHook: { expand: ((src: string, path: string) => Promise<string>) | null; version: number } = { expand: null, version: 0 };

export const prepareMarkdown = (pane: HTMLElement, src: string, vertical: boolean, path: string) =>
  prepare(pane, async (staging) => {
    const html = markdownHook.expand ? await markdownHook.expand(src, path) : markdownHtml(src);
    const el = surface(staging);
    el.className = `pview plain md ${vertical ? "vertical" : ""}`;
    el.innerHTML = html;
  }, vertical);

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

// Prepare images in the actual nodes that will be inserted. All tasks settle
// before revoking their URLs, including when one of several images fails.
const prepare = async (pane: HTMLElement, draw: (staging: HTMLElement) => void | Promise<void>, fromRight = false) => {
  const staging = document.createElement("div");
  const urls: string[] = [];
  const dispose = () => urls.splice(0).forEach((url) => URL.revokeObjectURL(url));
  try {
    await draw(staging);
    const results = await Promise.allSettled([...staging.querySelectorAll<HTMLImageElement>("img")].map(async (img) => {
      const source = img.dataset.src;
      if (source) {
        const url = await fileUrl(source);
        urls.push(url);
        img.src = url;
        img.removeAttribute("data-src");
      }
      if (img.getAttribute("src")?.trim()) await img.decode();
    }));
    const failure = results.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
    return {
      dispose,
      mount: () => {
        pane.classList.toggle("from-right", fromRight);
        pane.replaceChildren(...staging.childNodes);
        // Trigger layout so that fonts used by newly mounted content are discovered.
        void pane.scrollWidth;
        return document.fonts.ready;
      },
    };
  } catch (error) {
    dispose();
    throw error;
  }
};

export const preparePages = (pane: HTMLElement, paths: string[], zoom: () => number) =>
  prepare(pane, (staging) => {
    renderPageImages(staging, [], zoom());
    surface(staging).innerHTML = paths.map((path, i) =>
      `<figure class="page"><img data-src="${esc(path)}" alt=""><figcaption>${i + 1}</figcaption></figure>`,
    ).join("");
  }).then((content) => ({
    ...content,
    mount: () => {
      const ready = content.mount();
      surface(pane).style.setProperty("--zoom", String(zoom()));
      return ready;
    },
  }));

/** Tracks the scroll frame independently of the content being loaded for it. */
export const previewPane = (pane: HTMLElement, failed: (error: unknown, empty: boolean) => void) => {
  const max = () => ({ x: Math.max(0, pane.scrollWidth - pane.clientWidth), y: Math.max(0, pane.scrollHeight - pane.clientHeight) });
  const fromRight = (target: PreviewTarget) => target.mode === "plain" && target.vertical;
  const read = (target: PreviewTarget) => limitPosition(positionOf(pane.scrollLeft, pane.scrollTop, fromRight(target)), max());
  const updates = createPreviewUpdates({
    read, max, failed,
    write: (desired, target) => {
      const at = limitPosition(desired, max());
      pane.scrollLeft = fromRight(target) ? -at.x : at.x;
      pane.scrollTop = at.y;
      return read(target);
    },
  });
  const wheel = (e: WheelEvent) => { if (!e.ctrlKey && !e.metaKey && (e.deltaX || e.deltaY)) updates.moved(); };
  pane.addEventListener("scroll", updates.scrolled);
  pane.addEventListener("wheel", wheel, { passive: true });
  pane.addEventListener("touchmove", updates.moved, { passive: true });
  return {
    ...updates,
    close: () => {
      updates.close();
      pane.removeEventListener("scroll", updates.scrolled);
      pane.removeEventListener("wheel", wheel);
      pane.removeEventListener("touchmove", updates.moved);
    },
  };
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
