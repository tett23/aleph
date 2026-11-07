// Previews: the text without commands, the typeset pages (golem build + shem),
// Markdown, SVG, Mermaid and PDF.
import { emit } from "@tauri-apps/api/event";
import { marked } from "marked";
import { api, basename, type Out } from "./api";
import { bin, config } from "./config";
import { gmBlocks } from "./gm";
import { esc, icon } from "./icons";

export const renderPlain = (el: HTMLElement, src: string, vertical: boolean) => {
  el.className = `plain ${vertical ? "vertical" : ""}`;
  el.innerHTML = gmBlocks(src)
    .map((b) =>
      b.kind === "h"
        ? `<h${Math.min(6, b.level + 1)} data-line="${b.line}">${esc(b.text)}</h${Math.min(6, b.level + 1)}>`
        : b.kind === "p"
          ? `<p data-line="${b.line}">${esc(b.text)}</p>`
          : `<div class="plain-break">改ページ</div>`,
    )
    .join("");
};

/** golem build --target html, then the body of the chapter's XHTML: commands and expressions applied. */
export const buildChapterHtml = async (project: string, path: string): Promise<{ ok: boolean; html: string; log: string }> => {
  const out = await api.tool("golem", bin("golem"), project, ["build", "--target", "html"]);
  const log = (out.stdout + out.stderr).trim();
  const xhtml = `${project}/build/html/${path.slice(project.length + 1).replace(/\.gm$/, ".xhtml")}`;
  if (out.code !== 0 || !(await api.exists(xhtml))) return { ok: false, html: "", log };
  const doc = new DOMParser().parseFromString(await api.readText(xhtml), "application/xhtml+xml");
  doc.querySelectorAll("script, link, style").forEach((n) => n.remove());
  return { ok: true, html: doc.body?.innerHTML ?? "", log };
};

/** The evaluated chapter (Golem's HTML); falls back to the text without commands. */
export const renderEvaluated = (el: HTMLElement, html: string | null, src: string, vertical: boolean, note = "") => {
  if (html === null) {
    renderPlain(el, src, vertical);
    if (note) el.insertAdjacentHTML("afterbegin", `<div class="plain-note">${esc(note)}</div>`);
    return;
  }
  el.className = `plain evaluated ${vertical ? "vertical" : ""}`;
  el.innerHTML = html;
};

export const renderMarkdown = (el: HTMLElement, src: string, vertical: boolean) => {
  el.className = `plain md ${vertical ? "vertical" : ""}`;
  el.innerHTML = marked.parse(src, { async: false }) as string;
};

export const renderSvg = (el: HTMLElement, src: string) => {
  el.className = "media";
  const url = URL.createObjectURL(new Blob([src], { type: "image/svg+xml" }));
  el.innerHTML = `<img src="${url}" alt="">`;
};

let mermaidSeq = 0;
export const renderMermaid = async (el: HTMLElement, src: string) => {
  el.className = "media";
  const { default: mermaid } = await import("mermaid");
  mermaid.initialize({ startOnLoad: false, theme: document.body.classList.contains("theme-dark") ? "dark" : "default" });
  try {
    const { svg } = await mermaid.render(`m${++mermaidSeq}`, src);
    el.innerHTML = svg;
  } catch (e) {
    el.innerHTML = `<pre class="error">${esc(String(e))}</pre>`;
  }
};

const pngUrls = async (dir: string) => {
  const files = (await api.listDir(dir)).filter((p) => p.endsWith(".png")).sort();
  return Promise.all(
    files.map(async (p) => URL.createObjectURL(new Blob([await api.readBytes(p)], { type: "image/png" }))),
  );
};

/** Rasterizes a PDF with shem into PNG object URLs. */
export const rasterize = async (pdf: string, cwd: string): Promise<{ urls: string[]; out: Out }> => {
  const dir = await api.tempDir(`pages-${basename(pdf).replace(/\W/g, "_")}`);
  const out = await api.tool("shem", bin("shem"), cwd, ["render", "--dpi", String(config.dpi), pdf, dir]);
  return { urls: out.code === 0 ? await pngUrls(dir) : [], out };
};

export type BuildResult = { ok: boolean; log: string; pdf?: string; urls: string[] };

/** golem build --target pdf, then shem. Broadcasts the pages to other windows. */
export const buildPages = async (project: string): Promise<BuildResult> => {
  const out = await api.tool("golem", bin("golem"), project, ["build", "--target", "pdf"]);
  const log = (out.stdout + out.stderr).trim();
  if (out.code !== 0) return { ok: false, log, urls: [] };
  const pdfs = (await api.listDir(`${project}/build/pdf`)).filter((p) => p.endsWith(".pdf"));
  if (!pdfs.length) return { ok: false, log: log + "\nno PDF in build/pdf", urls: [] };
  const r = await rasterize(pdfs[0], project);
  const result = { ok: r.out.code === 0, log: [log, r.out.stderr.trim()].filter(Boolean).join("\n"), pdf: pdfs[0], urls: r.urls };
  await emit("aleph:pages", { project, ...result });
  return result;
};

export const renderPages = (el: HTMLElement, r: BuildResult | null, busy: boolean) => {
  el.className = "pages";
  if (busy && !r) {
    el.innerHTML = `<div class="hint">組んでいます…</div>`;
    return;
  }
  if (!r) {
    el.innerHTML = `<div class="hint">保存するか「組む」を押すと、golem build と shem でページを描きます。</div>`;
    return;
  }
  el.innerHTML =
    (r.ok ? "" : `<pre class="error">${esc(r.log || "失敗しました")}</pre>`) +
    r.urls.map((u, i) => `<figure class="page"><img src="${u}" alt=""><figcaption>${i + 1}</figcaption></figure>`).join("");
  if (busy) el.insertAdjacentHTML("afterbegin", `<div class="hint busy">組みなおしています…</div>`);
};

/** A PDF file: shem first (Golem's subset), the WebView's viewer otherwise. */
export const renderPdf = async (el: HTMLElement, path: string, cwd: string) => {
  el.className = "pages";
  el.innerHTML = `<div class="hint">描いています…</div>`;
  const r = await rasterize(path, cwd).catch(() => null);
  if (r && r.out.code === 0 && r.urls.length) {
    el.innerHTML = r.urls.map((u, i) => `<figure class="page"><img src="${u}" alt=""><figcaption>${i + 1}</figcaption></figure>`).join("");
    return;
  }
  const url = URL.createObjectURL(new Blob([await api.readBytes(path)], { type: "application/pdf" }));
  el.className = "media";
  el.innerHTML = `<div class="hint">shem で描けない PDF です（${esc(r?.out.stderr.split("\n")[0] ?? "")}）。WebView で表示します。</div><iframe src="${url}"></iframe>`;
};

export const renderImage = async (el: HTMLElement, path: string) => {
  el.className = "media";
  const type = /\.svg$/i.test(path) ? "image/svg+xml" : /\.png$/i.test(path) ? "image/png" : /\.gif$/i.test(path) ? "image/gif" : /\.webp$/i.test(path) ? "image/webp" : "image/jpeg";
  const url = URL.createObjectURL(new Blob([await api.readBytes(path)], { type }));
  el.innerHTML = `<img src="${url}" alt=""><div class="hint">${esc(basename(path))}</div>`;
};

// ---- zoom of the page preview, kept per viewer ----
export const zoom = () => {
  try {
    return Number(localStorage.getItem("pageZoom")) || 1;
  } catch {
    return 1;
  }
};
export const setZoom = (z: number) => {
  try {
    localStorage.setItem("pageZoom", String(Math.min(4, Math.max(0.3, z))));
  } catch {
    /* private storage: the zoom just is not kept */
  }
};
export const applyZoom = (scroller: HTMLElement) => scroller.style.setProperty("--zoom", String(zoom()));
export const zoomControls = () =>
  `<span class="zoom"><span class="iconbtn" data-zoom="out" title="縮小">${icon("zoom-out", 14)}</span><span class="zoomv" data-zoom="fit" title="幅に合わせる">${Math.round(zoom() * 100)}%</span><span class="iconbtn" data-zoom="in" title="拡大">${icon("zoom-in", 14)}</span></span>`;
