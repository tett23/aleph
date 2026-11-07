// The preview beside the editor (docs/adr/0010): Golem's HTML for the text,
// golem build and shem for the pages, and the other kinds; PDF and images
// replace the editor; the text and the pages can go to their own windows.
import { emit, listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { api } from "../api.ts";
import type { Ctx } from "../ctx.ts";
import type { Editor } from "../ed/editor.ts";
import { stubEditor } from "../editor/stub.ts";
import { esc } from "../esc.ts";
import { icon } from "../icons.ts";
import { basename, dirname, stem } from "../path.ts";
import { focused, type Doc, type State } from "../store.ts";
import { effectiveSide, verticalOn } from "../toolbar.ts";
import { golem, shem } from "../tools.ts";
import { item, toggle } from "../ui/settings.ts";
import { IMAGE_KINDS } from "../workspace.ts";
import { autoDpi, pageInches } from "./pages.ts";
import {
  fileUrl,
  loadZoom,
  onWheelZoom,
  plainHtml,
  renderHint,
  renderImage,
  renderMarkdown,
  renderMermaid,
  renderPageImages,
  renderPlain,
  renderSvg,
  saveZoom,
  withImagePaths,
  zoomByClick,
  zoomControls,
} from "./render.ts";
import { chapterBody, xhtmlPath } from "./xhtml.ts";

// ---- builds ----

/** Golem's HTML of a chapter, with its images as absolute paths in data-src. */
const html = new Map<string, string>();
type HtmlBuild = { busy: boolean; again: boolean; error: string };
const htmlBuilds = new Map<string, HtmlBuild>();

/** The pages of a project: PNG files drawn by shem from the PDF golem built. */
export type Pages = { pdf: string; pngs: string[]; dpi: number; ok: boolean; log: string };
const pages = new Map<string, Pages>();
const pageUrls = new Map<string, string[]>();
/** A build in progress, and what to run after it: null, a full build, or a redraw at a dpi. */
type PageBuild = { busy: boolean; again: null | { redraw: boolean; dpi?: number } };
const pageBuilds = new Map<string, PageBuild>();

const out = (o: { stdout: string; stderr: string }) => (o.stderr || o.stdout).trim();

const buildHtml = async (ctx: Ctx, project: string, paths: string[]) => {
  const b = htmlBuilds.get(project) ?? { busy: false, again: false, error: "" };
  htmlBuilds.set(project, b);
  if (b.busy) return void (b.again = true);
  b.busy = true;
  ctx.refresh(["side"]);
  try {
    const o = await golem(ctx, project, ["build", "--target", "html"]);
    b.error = o.code === 0 ? "" : out(o) || "golem build に失敗しました";
    if (o.code === 0)
      for (const p of paths) {
        const x = xhtmlPath(project, p);
        const body = chapterBody(await api.readText(x).catch(() => ""));
        if (body.html) html.set(p, withImagePaths(body.html, dirname(x)));
      }
  } catch (e) {
    b.error = String(e);
  }
  b.busy = false;
  ctx.refresh(["side"]);
  void sendPlain(ctx);
  if (b.again) {
    b.again = false;
    void buildHtml(ctx, project, paths);
  }
};

/** The dpi the main window's pane wants now. */
const wantedDpi = (ctx: Ctx, project: string) => {
  const body = document.querySelector<HTMLElement>(".side-pane .pbody");
  return autoDpi({ width: body?.clientWidth || 500, ratio: devicePixelRatio, zoom, inches: styles.get(project) ?? 148 / 25.4, fixed: ctx.config.dpi });
};

const rasterize = async (ctx: Ctx, project: string, pdf: string, dpi: number): Promise<Pages> => {
  const dir = await api.tempDir(`pages-${basename(project).replace(/[^\w]/g, "_")}-${dpi}`);
  const o = await shem(ctx, project, ["render", "--dpi", String(dpi), pdf, dir]);
  const pngs = o.code === 0 ? (await api.listDir(dir)).filter((p) => p.endsWith(".png")).sort() : [];
  return { pdf, pngs, dpi, ok: o.code === 0 && pngs.length > 0, log: o.code === 0 ? "" : out(o) || "shem render に失敗しました" };
};

const publishPages = async (ctx: Ctx, project: string, p: Pages) => {
  pages.set(project, p);
  pageUrls.get(project)?.forEach((u) => URL.revokeObjectURL(u));
  pageUrls.set(project, await Promise.all(p.pngs.map(fileUrl)));
  ctx.refresh(["side"]);
  await emit("aleph:pages", { project, ...p }).catch(() => {});
};

/** golem build --target pdf, then shem; with `redraw`, only shem on the PDF already built. */
const buildPages = async (ctx: Ctx, project: string, redraw = false, dpi = wantedDpi(ctx, project)) => {
  const b = pageBuilds.get(project) ?? { busy: false, again: null };
  pageBuilds.set(project, b);
  // a full build asked for meanwhile wins over a redraw
  if (b.busy) {
    const fullPending = b.again !== null && !b.again.redraw;
    if (!fullPending) b.again = { redraw, dpi };
    return;
  }
  b.busy = true;
  ctx.refresh(["side"]);
  try {
    const prev = pages.get(project);
    let pdf = redraw ? prev?.pdf : undefined;
    let log = "";
    if (!pdf) {
      const o = await golem(ctx, project, ["build", "--target", "pdf"]);
      log = o.code === 0 ? "" : out(o) || "golem build に失敗しました";
      pdf = o.code === 0 ? (await api.listDir(`${project}/build/pdf`)).find((f) => f.endsWith(".pdf")) : undefined;
      if (o.code === 0 && !pdf) log = "build/pdf に PDF がありません";
    }
    if (!pdf) pages.set(project, { ...(prev ?? { pdf: "", pngs: [], dpi }), ok: false, log });
    else await publishPages(ctx, project, await rasterize(ctx, project, pdf, dpi));
  } catch (e) {
    pages.set(project, { ...(pages.get(project) ?? { pdf: "", pngs: [], dpi }), ok: false, log: String(e) });
  }
  b.busy = false;
  ctx.refresh(["side"]);
  if (b.again) {
    const next = b.again;
    b.again = null;
    void buildPages(ctx, project, next.redraw, next.redraw ? next.dpi : undefined);
  }
};

// ---- the pane beside the editor ----

let zoom = loadZoom();
let lastKey = "";
let detach: (() => void) | null = null;
const styles = new Map<string, number>();

const inchesOf = async (project: string) => {
  if (!styles.has(project)) styles.set(project, pageInches(await api.readText(`${project}/style.toml`).catch(() => "")));
  return styles.get(project)!;
};

const chaptersShown = (s: State) => s.open.filter((d) => d.kind === "gm");

const drawSide = (head: HTMLElement, body: HTMLElement, ctx: Ctx) => {
  const s = ctx.store.get();
  const d = focused(s);
  const pane = body.closest<HTMLElement>(".side-pane")!;
  const side = d && !s.plot ? effectiveSide(d.kind, s.side) : "none";
  pane.hidden = side === "none";
  if (side === "none") {
    lastKey = "";
    return;
  }
  const doc = d!;
  if (side === "pages") return drawPages(head, body, ctx, doc);
  const project = doc.project ?? "";
  const hb = htmlBuilds.get(project);
  const note = hb?.busy ? "組んでいます…" : hb?.error ? "組めませんでした（前の結果を出しています）" : "";
  head.innerHTML = `<span>${doc.kind === "gm" ? "本文" : "プレビュー"}</span>${note ? `<small class="${hb?.error ? "ng" : ""}" title="${esc(hb?.error ?? "")}">${esc(note)}</small>` : ""}<span class="sp"></span>${
    doc.kind === "gm" ? `<span class="iconbtn" data-win="plain" title="別のウィンドウに出す">${icon("external-link", 14)}</span>` : ""
  }`;
  head.onclick = (e) => {
    if ((e.target as HTMLElement).closest("[data-win]")) void openWindow(ctx, "plain", project);
  };
  if (doc.kind === "gm") {
    const docs = chaptersShown(s);
    const key = `plain|${s.vertical}|${docs.map((x) => `${x.path}:${html.has(x.path) ? html.get(x.path)!.length : x.saved.length}`).join()}|${note}`;
    if (key === lastKey && body.querySelector(".pview")) return;
    lastKey = key;
    if (project && docs.some((x) => !html.has(x.path)) && !hb?.busy && !hb?.error) void buildHtml(ctx, project, docs.map((x) => x.path));
    // several chapters open: written horizontally (docs/adr/0006), and so is their text
    return renderPlain(body, sectionsOf(docs), verticalOn(s));
  }
  const key = `${doc.kind}|${s.vertical}|${doc.path}|${doc.text}`;
  if (key === lastKey && body.querySelector(".pview")) return;
  lastKey = key;
  if (doc.kind === "md") return renderMarkdown(body, doc.text, s.vertical);
  if (doc.kind === "svg") return renderSvg(body, doc.text);
  if (doc.kind === "mmd") return void renderMermaid(body, doc.text);
};

const sectionsOf = (docs: Doc[]) => docs.map((x) => ({ title: stem(x.path), html: html.get(x.path) ?? plainHtml(x.saved) }));

const drawPages = (head: HTMLElement, body: HTMLElement, ctx: Ctx, doc: Doc) => {
  const project = doc.project;
  if (!project) {
    head.innerHTML = "<span>ページ</span>";
    return renderHint(body, "Golem のプロジェクトの章で使えます");
  }
  const p = pages.get(project);
  const busy = pageBuilds.get(project)?.busy ?? false;
  const note = busy ? (p ? "組みなおしています…" : "組んでいます…") : p && !p.ok ? "組めませんでした" : "";
  head.innerHTML = `<span>ページ</span>${note ? `<small class="${p && !p.ok && !busy ? "ng" : ""}">${esc(note)}</small>` : ""}<span class="sp"></span>${zoomControls(zoom)}<span class="iconbtn" data-act="build" title="組みなおす">${icon(
    "refresh-cw",
    14,
  )}</span><span class="iconbtn" data-win="pages" title="別のウィンドウに出す">${icon("external-link", 14)}</span>`;
  head.onclick = (e) => {
    const t = e.target as HTMLElement;
    const z = zoomByClick(t, zoom);
    if (z !== null) return setZoom(ctx, project, z);
    if (t.closest("[data-act=build]")) return void buildPages(ctx, project);
    if (t.closest("[data-win]")) void openWindow(ctx, "pages", project);
  };
  detach?.();
  detach = onWheelZoom(body, () => zoom, (z) => setZoom(ctx, project, z));
  watchWidth(ctx, body, project);
  // open with "pages" chosen and nothing built yet: build now
  if (!p && !busy) return void buildPages(ctx, project);
  const urls = pageUrls.get(project) ?? [];
  const key = `pages|${project}|${urls.join()}|${p?.log ?? ""}`;
  if (key === lastKey && body.querySelector(".pview")) return void body.querySelector<HTMLElement>(".pview")!.style.setProperty("--zoom", String(zoom));
  lastKey = key;
  if (!urls.length) return p && !p.ok ? renderHint(body, p.log, true) : renderHint(body, "組んでいます…");
  renderPageImages(body, urls, zoom, p && !p.ok ? p.log : "");
};

const setZoom = (ctx: Ctx, project: string, z: number) => {
  zoom = z;
  saveZoom(z);
  ctx.refresh(["side"]);
  sharpen(ctx, project);
};

/** Draws the PDF again with shem when the pane needs more pixels than the pages have. */
const sharpen = (ctx: Ctx, project: string) => {
  const p = pages.get(project);
  if (!p?.ok || ctx.config.dpi > 0) return;
  const want = wantedDpi(ctx, project);
  if (want > p.dpi) void buildPages(ctx, project, true, want);
};

let resize: ResizeObserver | null = null;
let resizeTimer = 0;
const watchWidth = (ctx: Ctx, body: HTMLElement, project: string) => {
  resize?.disconnect();
  resize = new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => sharpen(ctx, project), 300);
  });
  resize.observe(body);
};

// ---- other windows ----

const sendPlain = async (ctx: Ctx) => {
  const s = ctx.store.get();
  await emit("aleph:plain", { sections: sectionsOf(chaptersShown(s)), vertical: verticalOn(s) }).catch(() => {});
};

const openWindow = async (ctx: Ctx, view: "plain" | "pages", project: string) => {
  const label = `${view}-${Math.abs([...project].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7))}`;
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) return void existing.setFocus();
  const w = new WebviewWindow(label, {
    url: `index.html?view=${view}&project=${encodeURIComponent(project)}`,
    title: `${view === "pages" ? "ページ" : "本文"} — ${basename(project)}`,
    width: 620,
    height: 820,
  });
  w.once("tauri://error", (e) => ctx.toast(`ウィンドウを開けません：${String(e.payload)}`));
};

// ---- PDF and images in place of the editor ----

/** A PDF: shem first (the subset Golem writes), the WebView's viewer otherwise. */
const pdfView = (el: HTMLElement, doc: Doc, ctx: Ctx): Editor => {
  const pane = document.createElement("div");
  pane.className = "pbody";
  el.append(pane);
  renderHint(pane, "描いています…");
  void (async () => {
    const cwd = doc.project ?? dirname(doc.path);
    const r = await rasterize(ctx, cwd, doc.path, autoDpi({ width: pane.clientWidth, ratio: devicePixelRatio, zoom: 1, inches: 8.27, fixed: ctx.config.dpi })).catch(() => null);
    if (r?.ok) return renderPageImages(pane, await Promise.all(r.pngs.map(fileUrl)), 1);
    const url = await fileUrl(doc.path);
    renderHint(pane, "");
    pane.querySelector(".pview")!.innerHTML = `<div class="hint">shem で描けない PDF です。WebView で表示します。</div><iframe src="${url}"></iframe>`;
    pane.querySelector<HTMLElement>(".pview")!.className = "pview media";
  })();
  return stubEditor(() => pane.remove());
};

const imageView = (el: HTMLElement, doc: Doc): Editor => {
  const pane = document.createElement("div");
  pane.className = "pbody";
  el.append(pane);
  void renderImage(pane, doc.path);
  return stubEditor(() => pane.remove());
};

export const mountPreview = (ctx: Ctx) => {
  ctx.view.side = (head, body) => {
    const d = focused(ctx.store.get());
    if (d?.project && !styles.has(d.project)) void inchesOf(d.project).then(() => ctx.refresh(["side"]));
    drawSide(head, body, ctx);
  };
  ctx.kindViews.pdf = pdfView;
  for (const k of IMAGE_KINDS) ctx.kindViews[k] = (el, doc) => imageView(el, doc);

  // after a save: the text is built again; the pages too when the setting says so
  ctx.store.subscribe((s, prev) => {
    for (const d of s.open) {
      const before = prev.open.find((x) => x.path === d.path);
      if (!before || before.saved === d.saved) continue;
      if (d.path.endsWith("/style.toml")) styles.delete(d.project ?? "");
      if (!d.project) continue;
      if (d.kind === "gm") void buildHtml(ctx, d.project, chaptersShown(s).map((x) => x.path));
      if (ctx.config.rebuildOnSave && (pages.has(d.project) || effectiveSide(d.kind, s.side) === "pages")) void buildPages(ctx, d.project);
    }
    if (s.vertical !== prev.vertical || s.open !== prev.open) void sendPlain(ctx);
  });

  // the preview windows ask for what they show, and for a sharper drawing
  void listen<{ project: string }>("aleph:plain-want", () => void sendPlain(ctx));
  void listen<{ project: string; dpi?: number }>("aleph:pages-want", (e) => {
    const { project, dpi } = e.payload;
    const p = pages.get(project);
    if (!p) return void buildPages(ctx, project);
    if (dpi && dpi > p.dpi && ctx.config.dpi === 0) return void buildPages(ctx, project, true, dpi);
    void emit("aleph:pages", { project, ...p });
  });

  ctx.settings.push({
    id: "preview",
    label: "プレビュー",
    group: "Golem",
    render: (c) =>
      item("保存したらページを組みなおす", "golem build と shem をもう一度実行する", toggle("rebuildOnSave", c.config.rebuildOnSave)) +
      item("ページの解像度", "空なら、枠の幅、画面の倍率、拡大率、判型から自動で決める", `<input class="field num" type="number" min="36" max="1200" data-num="dpi" value="${c.config.dpi || ""}" placeholder="自動"> dpi`),
    onClick: async (el, c) => {
      if (el.closest<HTMLElement>("[data-toggle]")?.dataset.toggle !== "rebuildOnSave") return false;
      c.config.rebuildOnSave = !c.config.rebuildOnSave;
      await c.saveConfig();
      return true;
    },
    onChange: async (el, c) => {
      if (el.dataset.num !== "dpi") return false;
      c.config.dpi = el.value === "" ? 0 : Number(el.value);
      await c.saveConfig();
      return true;
    },
  });
};
