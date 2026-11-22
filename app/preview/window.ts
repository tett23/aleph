// A preview in its own window (docs/adr/0010). The text follows the shown
// sheets in the main window. The pages window follows its own project.
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api } from "../api.ts";
import { normalize } from "../config.ts";
import { applyTheme, mountAppearance } from "../theme.ts";
import { setUiState, windowUiState } from "../uistate.ts";
import { autoDpi, pageInches } from "./pages.ts";
import { loadZoom, onWheelZoom, preparePages, preparePlain, previewPane, renderHint, saveZoom, zoomByClick, zoomControls } from "./render.ts";
import { createPreviewFeed } from "./update.ts";
import type { Pages, PagesNotice, PlainNotice } from "./mount.ts";

export const startPreviewWindow = async (view: "pages" | "plain", project: string, workspace: string) => {
  const config = normalize(JSON.parse(await api.configLoad().catch(() => "{}")));
  applyTheme(config);
  mountAppearance(config);
  setUiState(windowUiState(config.ui, (part) => void emit("aleph:ui", part)));
  const app = document.getElementById("app")!;
  app.innerHTML = `<div class="pwin"><div class="phead" data-tauri-drag-region></div><div class="pbody"></div></div>`;
  const head = app.querySelector<HTMLElement>(".phead")!;
  const body = app.querySelector<HTMLElement>(".pbody")!;
  let error = "";
  let busy = true;
  let zoom = loadZoom();
  let got: Pages | undefined;
  const drawHead = () => {
    head.innerHTML = `<span>${view === "pages" ? "ページ" : "本文"}</span><small data-preview-status></small><span class="sp"></span>${view === "pages" ? zoomControls(zoom) : ""}`;
    const status = head.querySelector<HTMLElement>("[data-preview-status]")!;
    status.classList.toggle("ng", !!error);
    status.title = error;
    status.textContent = error ? "更新できませんでした" : busy ? "更新しています…" : "";
  };
  const updates = previewPane(body, (failure, empty) => {
    error = String(failure);
    busy = false;
    if (empty) renderHint(body, error, true);
    drawHead();
  });
  let closed = false;
  const cleanup: (() => void)[] = [updates.close];
  window.addEventListener("pagehide", () => {
    closed = true;
    cleanup.splice(0).forEach((off) => off());
  }, { once: true });
  const keep = async (registration: Promise<UnlistenFn>) => {
    const off = await registration;
    if (closed) off();
    else cleanup.push(off);
  };
  drawHead();
  renderHint(body, "待っています…");

  if (view === "plain") {
    const take = createPreviewFeed((target) => target.mode === "plain");
    await keep(listen<PlainNotice>("aleph:plain", ({ payload: { target, generation, sections, error: problem } }) => {
      const ready = !!sections || problem !== undefined;
      if (!take(target, generation, ready)) return;
      error = "";
      busy = !ready;
      drawHead();
      if (!ready) updates.select(target, generation);
      else void updates.request(target, generation, async () => {
        if (problem !== undefined) throw new Error(problem);
        return preparePlain(body, sections!, target.vertical);
      });
    }));
    if (!closed) await emit("aleph:plain-want", { project, workspace });
    return;
  }

  const inches = pageInches(await api.readText(`${project}/style.toml`).catch(() => ""));
  if (closed) return;
  const want = () => autoDpi({ width: body.clientWidth, ratio: devicePixelRatio, zoom, inches, fixed: config.dpi });
  const sharpen = () => {
    if (!busy && !error && got?.ok && config.dpi === 0 && want() > got.dpi)
      void emit("aleph:pages-want", { project, workspace, dpi: want() });
  };
  const setZoom = (z: number) => {
    zoom = z;
    saveZoom(z);
    drawHead();
    body.querySelector<HTMLElement>(".pview.pages")?.style.setProperty("--zoom", String(z));
    sharpen();
  };
  head.onclick = (e) => {
    const z = zoomByClick(e.target as HTMLElement, zoom);
    if (z !== null) setZoom(z);
  };
  cleanup.push(onWheelZoom(body, () => zoom, setZoom));
  let timer = 0;
  const resize = new ResizeObserver(() => {
    clearTimeout(timer);
    timer = window.setTimeout(sharpen, 300);
  });
  resize.observe(body);
  cleanup.push(() => { clearTimeout(timer); resize.disconnect(); });
  const take = createPreviewFeed((target) => target.mode === "pages" && target.project === project && target.workspace === workspace);
  await keep(listen<PagesNotice>("aleph:pages", ({ payload: { target, generation, pages, error: problem } }) => {
    const ready = !!pages || problem !== undefined;
    if (!take(target, generation, ready)) return;
    error = "";
    busy = true;
    drawHead();
    if (!ready) return void updates.select(target, generation);
    void updates.request(target, generation, async () => {
      if (problem !== undefined) throw new Error(problem);
      const content = await preparePages(body, pages!.pngs, () => zoom);
      return {
        ...content,
        mount: () => {
          const fonts = content.mount();
          got = pages;
          busy = false;
          drawHead();
          return Promise.resolve(fonts).then(sharpen);
        },
      };
    });
  }));
  if (!closed) await emit("aleph:pages-want", { project, workspace, dpi: want() });
};
