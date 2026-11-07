// A preview in its own window (docs/adr/0010): the pages or the text, sent by
// the main window as events. The pages window asks for a sharper drawing when
// its own width and zoom need more pixels.
import { emit, listen } from "@tauri-apps/api/event";
import { api } from "../api.ts";
import { normalize } from "../config.ts";
import { applyTheme } from "../theme.ts";
import { autoDpi, pageInches } from "./pages.ts";
import { fileUrl, loadZoom, onWheelZoom, renderHint, renderPageImages, renderPlain, saveZoom, zoomByClick, zoomControls, type PlainSection } from "./render.ts";
import type { Pages } from "./mount.ts";

export const startPreviewWindow = async (view: "pages" | "plain", project: string) => {
  const config = normalize(JSON.parse(await api.configLoad().catch(() => "{}")));
  applyTheme(config);
  const app = document.getElementById("app")!;
  app.innerHTML = `<div class="pwin"><div class="phead" data-tauri-drag-region></div><div class="pbody"></div></div>`;
  const head = app.querySelector<HTMLElement>(".phead")!;
  const body = app.querySelector<HTMLElement>(".pbody")!;

  if (view === "plain") {
    head.innerHTML = `<span>本文</span>`;
    renderHint(body, "待っています…");
    await listen<{ sections: PlainSection[]; vertical: boolean }>("aleph:plain", (e) => renderPlain(body, e.payload.sections, e.payload.vertical));
    await emit("aleph:plain-want", { project });
    return;
  }

  const inches = pageInches(await api.readText(`${project}/style.toml`).catch(() => ""));
  let zoom = loadZoom();
  let got: Pages | null = null;
  let urls: string[] = [];
  const want = () => autoDpi({ width: body.clientWidth, ratio: devicePixelRatio, zoom, inches, fixed: config.dpi });
  const drawHead = () => {
    head.innerHTML = `<span>ページ</span>${got && !got.ok ? `<small class="ng">組めませんでした</small>` : ""}<span class="sp"></span>${zoomControls(zoom)}`;
  };
  const sharpen = () => {
    if (got?.ok && config.dpi === 0 && want() > got.dpi) void emit("aleph:pages-want", { project, dpi: want() });
  };
  const setZoom = (z: number) => {
    zoom = z;
    saveZoom(z);
    drawHead();
    body.querySelector<HTMLElement>(".pview")?.style.setProperty("--zoom", String(z));
    sharpen();
  };
  head.onclick = (e) => {
    const z = zoomByClick(e.target as HTMLElement, zoom);
    if (z !== null) setZoom(z);
  };
  onWheelZoom(body, () => zoom, setZoom);
  let timer = 0;
  new ResizeObserver(() => {
    clearTimeout(timer);
    timer = window.setTimeout(sharpen, 300);
  }).observe(body);
  drawHead();
  renderHint(body, "組んでいます…");
  await listen<Pages & { project: string }>("aleph:pages", async (e) => {
    if (e.payload.project !== project) return;
    got = e.payload;
    drawHead();
    if (!got.ok && !got.pngs.length) return renderHint(body, got.log, true);
    const next = await Promise.all(got.pngs.map(fileUrl).map((p) => p.catch(() => "")));
    urls.forEach((u) => URL.revokeObjectURL(u));
    urls = next;
    renderPageImages(body, urls, zoom, got.ok ? "" : got.log);
    sharpen();
  });
  await emit("aleph:pages-want", { project, dpi: want() });
};
