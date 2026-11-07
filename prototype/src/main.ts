// Entry: the main window, or a detached window for pages, plain text or the plot.
import "./style.css";
import { emit, listen } from "@tauri-apps/api/event";
import { api, basename } from "./api";
import { loadConfig } from "./config";
import { icon } from "./icons";
import { mountPlot } from "./plot";
import { applyZoom, autoDpi, pageInches, buildChapterHtml, renderEvaluated, renderPages, setZoom, zoom, zoomControls, type BuildResult } from "./preview";

const q = new URLSearchParams(location.search);
const view = q.get("view") ?? "main";

const detached = (title: string) => {
  const app = document.getElementById("app")!;
  app.style.flexDirection = "column";
  app.innerHTML = `<div class="toolbar drag" data-tauri-drag-region style="padding-left:80px"><span class="title" data-tauri-drag-region>${title}</span><span class="tools"></span></div><div class="pbody" style="flex:1;overflow:auto;background:var(--bg-2)"></div>`;
  const scroller = app.querySelector<HTMLElement>(".pbody")!;
  const body = document.createElement("div"); // renderers set their own class on it
  scroller.append(body);
  return { tools: app.querySelector<HTMLElement>(".tools")!, body, scroller };
};

const main = async () => {
  await loadConfig();
  if (view === "pages") {
    const project = q.get("project")!;
    const { tools, body, scroller } = detached(`ページ — ${basename(project)}`);
    const drawTools = () => (tools.innerHTML = `${zoomControls()}<span class="iconbtn" data-build title="組む">${icon("refresh-cw")}</span>`);
    drawTools();
    applyZoom(scroller);
    let last: BuildResult | null = null;
    const inches = await pageInches(project);
    const request = () => emit("aleph:build-request", { project, dpi: autoDpi(scroller.clientWidth, inches, zoom()) });
    renderPages(body, null, false);
    tools.onclick = (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>("[data-zoom],[data-build]");
      if (t?.dataset.zoom) {
        setZoom(t.dataset.zoom === "in" ? zoom() * 1.25 : t.dataset.zoom === "out" ? zoom() / 1.25 : 1);
        applyZoom(scroller);
        drawTools();
        if (last?.dpi && autoDpi(scroller.clientWidth, inches, zoom()) > last.dpi * 1.05) request();
      } else if (t?.dataset.build !== undefined) {
        renderPages(body, last, true);
        request();
      }
    };
    await listen<BuildResult & { project: string }>("aleph:pages", (e) => {
      if (e.payload.project !== project) return;
      last = e.payload;
      renderPages(body, last, false);
    });
    await emit("aleph:pages-window", { project });
    request();
  } else if (view === "plot") {
    const project = q.get("project")!;
    const { scroller } = detached(`プロット — ${basename(project)}`);
    scroller.style.background = "var(--bg)";
    scroller.style.overflow = "hidden";
    mountPlot(scroller, project, { standalone: true });
  } else if (view === "plain") {
    const path = q.get("path")!;
    const { tools, body } = detached(`本文 — ${basename(path)}`);
    let vertical = false;
    const project = q.get("project") || "";
    let last = "";
    let html: string | null = null;
    const draw = async () => {
      const src = await api.readText(path);
      if (project && src !== last) {
        const r = await buildChapterHtml(project, path);
        if (r.ok) html = r.html;
      }
      last = src;
      renderEvaluated(body, html, src, vertical);
    };
    tools.innerHTML = `<span class="seg"><span data-v="1">縦</span><span data-v="0" class="on">横</span></span>`;
    tools.onclick = (e) => {
      const v = (e.target as HTMLElement).dataset.v;
      if (v === undefined) return;
      vertical = v === "1";
      tools.querySelectorAll("[data-v]").forEach((s) => s.classList.toggle("on", (s as HTMLElement).dataset.v === v));
      renderEvaluated(body, html, last, vertical);
    };
    draw();
    setInterval(draw, 1500); // follows the autosave of the main window
  } else {
    const { start } = await import("./app");
    await start();
  }
};

main();
