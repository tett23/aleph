// The preview (docs/adr/0010), shown in the preview tab (docs/adr/0087): Golem's HTML
// for the text, golem build and shem for the pages, and the other kinds; PDF and images
// replace the editor; the text and the pages can go to their own windows.
import { emit, listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { api } from "../api.ts";
import type { Ctx } from "../ctx.ts";
import type { Editor } from "../ed/editor.ts";
import { stubEditor } from "../editor/stub.ts";
import { esc } from "../esc.ts";
import { icon } from "../icons.ts";
import { argPath, basename, dirname, stem } from "../path.ts";
import { allDocs, shown, shownDoc, type Doc, type PreviewMode, type State } from "../store.ts";
import { previewLabel, previewsFor, verticalOn } from "../toolbar.ts";
import { previewMessage, previewShows, rebuildPagesOnSave } from "./tab.ts";
import { golem, shem } from "../tools.ts";
import { item, toggle } from "../ui/settings.ts";
import { IMAGE_KINDS } from "../workspace.ts";
import { autoDpi, pageInches } from "./pages.ts";
import { createPageSaves } from "./page-saves.ts";
import { createWaiter } from "./wait.ts";
import { withBuildDir } from "../buildlock.ts";
import {
  fileUrl,
  loadZoom,
  onWheelZoom,
  plainHtml,
  renderHint,
  renderImage,
  markdownHook,
  renderMarkdown,
  renderMermaid,
  renderPageImages,
  renderPlain,
  renderSvg,
  saveZoom,
  zoomByClick,
  zoomControls,
} from "./render.ts";
import { xhtmlPath } from "./xhtml.ts";
import { chapterBody } from "./xhtmldom.ts";

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
type PageBuild = { busy: boolean; again: null | { redraw: boolean; dpi?: number; onlyChanged: boolean } };
const pageBuilds = new Map<string, PageBuild>();

const out = (o: { stdout: string; stderr: string }) => (o.stderr || o.stdout).trim();

const buildHtml = async (ctx: Ctx, project: string, paths: string[]) => {
  const b = htmlBuilds.get(project) ?? { busy: false, again: false, error: "" };
  htmlBuilds.set(project, b);
  if (b.busy) return void (b.again = true);
  b.busy = true;
  ctx.refresh(["previewTab"]);
  try {
    const o = await withBuildDir(project, () => golem(ctx, project, ["build", "--target", "html"]));
    b.error = o.code === 0 ? "" : out(o) || "golem build に失敗しました";
    if (o.code === 0)
      for (const p of paths) {
        const x = xhtmlPath(project, p);
        const body = chapterBody(await api.readText(x).catch(() => ""), { dir: dirname(x), root: `${project}/build/html` });
        if (body.html) html.set(p, body.html);
      }
  } catch (e) {
    b.error = String(e);
  }
  b.busy = false;
  ctx.refresh(["previewTab"]);
  void sendPlain(ctx);
  if (b.again) {
    b.again = false;
    void buildHtml(ctx, project, paths);
  }
};

/** The dpi the preview tab wants now: by its body's width, or 500 px when it has none (absent or hidden). */
const wantedDpi = (ctx: Ctx, project: string) => {
  const body = document.querySelector<HTMLElement>(".preview-tab .pbody");
  return autoDpi({ width: body?.clientWidth || 500, ratio: devicePixelRatio, zoom, inches: styles.get(project) ?? 148 / 25.4, fixed: ctx.config.dpi });
};

const rasterize = async (ctx: Ctx, project: string, pdf: string, dpi: number): Promise<Pages> => {
  const dir = await api.tempDir(`pages-${basename(project).replace(/[^\w]/g, "_")}-${dpi}`);
  const o = await shem(ctx, project, ["render", "--dpi", String(dpi), argPath(pdf), argPath(dir)]);
  const pngs = o.code === 0 ? (await api.listDir(dir)).filter((p) => p.endsWith(".png")).sort() : [];
  return { pdf, pngs, dpi, ok: o.code === 0 && pngs.length > 0, log: o.code === 0 ? "" : out(o) || "shem render に失敗しました" };
};

const publishPages = async (ctx: Ctx, project: string, p: Pages) => {
  pages.set(project, p);
  pageUrls.get(project)?.forEach((u) => URL.revokeObjectURL(u));
  pageUrls.set(project, await Promise.all(p.pngs.map(fileUrl)));
  ctx.refresh(["previewTab"]);
  await emit("aleph:pages", { project, ...p }).catch(() => {});
};

// builds after a save wait until the input has stopped for 5 s (docs/adr/0056)
const waiter = createWaiter({ now: () => Date.now(), set: (fn, ms) => window.setTimeout(fn, ms), clear: (id) => clearTimeout(id) });

const pageSaves = createPageSaves(waiter);

/** golem build --target pdf, then shem; with `redraw`, only shem on the PDF already built. */
const buildPages = async (ctx: Ctx, project: string, redraw = false, dpi = wantedDpi(ctx, project), onlyChanged = false) => {
  // a build now (the button, the first one) takes the place of one waiting for the input to stop
  if (!redraw) waiter.cancel(project);
  const b = pageBuilds.get(project) ?? { busy: false, again: null };
  pageBuilds.set(project, b);
  // a full build asked for meanwhile wins over a redraw
  if (b.busy) {
    const fullPending = b.again !== null && !b.again.redraw;
    if (!fullPending || (!redraw && !onlyChanged)) b.again = { redraw, dpi, onlyChanged };
    return;
  }
  const inputs = pageSaves.inputsFor(project);
  if (onlyChanged && !inputs.changed()) {
    ctx.refresh(["previewTab"]);
    return;
  }
  b.busy = true;
  ctx.refresh(["previewTab"]);
  try {
    let snapshot: Map<string, string> | undefined;
    const prev = pages.get(project);
    let pdf = redraw ? prev?.pdf : undefined;
    let log = "";
    if (!pdf) {
      const o = await withBuildDir(project, async () => {
        if (onlyChanged && !inputs.changed()) return null;
        snapshot = inputs.snapshot();
        return golem(ctx, project, ["build", "--target", "pdf"]);
      });
      if (!o) return;
      log = o.code === 0 ? "" : out(o) || "golem build に失敗しました";
      pdf = o.code === 0 ? (await api.listDir(`${project}/build/pdf`)).find((f) => f.endsWith(".pdf")) : undefined;
      if (o.code === 0 && !pdf) log = "build/pdf に PDF がありません";
    }
    if (!pdf) pages.set(project, { ...(prev ?? { pdf: "", pngs: [], dpi }), ok: false, log });
    else {
      const result = await rasterize(ctx, project, pdf, dpi);
      await publishPages(ctx, project, result);
      if (result.ok && snapshot) inputs.publish(snapshot);
    }
  } catch (e) {
    pages.set(project, { ...(pages.get(project) ?? { pdf: "", pngs: [], dpi }), ok: false, log: String(e) });
  } finally {
    b.busy = false;
    ctx.refresh(["previewTab"]);
    if (b.again) {
      const next = b.again;
      b.again = null;
      void buildPages(ctx, project, next.redraw, next.redraw ? next.dpi : undefined, next.onlyChanged);
    }
  }
};

// ---- the preview tab ----

let zoom = loadZoom();
let lastKey = "";
let detach: (() => void) | null = null;
const styles = new Map<string, number>();

const inchesOf = async (project: string) => {
  if (!styles.has(project)) styles.set(project, pageInches(await api.readText(`${project}/style.toml`).catch(() => "")));
  return styles.get(project)!;
};

/** The chapters of the shown tab: the text of all of them is shown together. */
const chaptersShown = (s: State) => shown(s).open.filter((d) => d.kind === "gm");

/** Whether the shown sheets are written vertically (docs/adr/0019), by the shown tab (docs/adr/0087). */
const verticalShown = (s: State) => verticalOn({ vertical: s.vertical, open: shown(s).open });

/** The head's left part: the shown sheet's name ("ほか N 章" for chapters together) and, for a .gm, the switch of the text and the pages. */
const headLeft = (s: State, ctx: Ctx, doc: Doc | null) => {
  if (!doc) return "";
  const { open } = shown(s);
  const others = open.length > 1 ? ` <small>ほか ${open.length - 1} 章</small>` : "";
  const name = `<span class="pname">${esc(ctx.titles.get(doc.path) ?? stem(doc.path))}</span>${others}`;
  const modes = previewsFor(doc.kind);
  const seg = modes.length > 1 ? `<span class="seg">${modes.map((m) => `<span data-preview-mode="${m}" class="${s.previewMode === m ? "on" : ""}">${previewLabel(doc.kind, m)}</span>`).join("")}</span>` : "";
  return name + seg;
};

/** The head's clicks shared by every content: the switch of the text and the pages. */
const modeClick = (ctx: Ctx, e: MouseEvent) => {
  const m = (e.target as HTMLElement).closest<HTMLElement>("[data-preview-mode]")?.dataset.previewMode;
  if (m) ctx.store.dispatch({ type: "previewMode", mode: m as PreviewMode });
  return !!m;
};

const drawTab = (head: HTMLElement, body: HTMLElement, ctx: Ctx) => {
  const s = ctx.store.get();
  const doc = shownDoc(s);
  const what = previewShows(doc, s.previewMode);
  if (what === "none" || what === "empty") {
    head.innerHTML = headLeft(s, ctx, doc);
    head.onclick = (e) => void modeClick(ctx, e);
    lastKey = "";
    return renderHint(body, previewMessage(what));
  }
  const d = doc!;
  if (what === "pages") return drawPages(head, body, ctx, d, s);
  const project = d.project ?? "";
  const hb = htmlBuilds.get(project);
  const note = hb?.busy ? "組んでいます…" : hb?.error ? "組めませんでした（前の結果を出しています）" : "";
  head.innerHTML = `${headLeft(s, ctx, d)}${note ? `<small class="${hb?.error ? "ng" : ""}" title="${esc(hb?.error ?? "")}">${esc(note)}</small>` : ""}<span class="sp"></span>${
    d.kind === "gm" ? `<span class="iconbtn" data-win="plain" title="別のウィンドウに出す">${icon("external-link", 14)}</span>` : ""
  }`;
  head.onclick = (e) => {
    if (modeClick(ctx, e)) return;
    if ((e.target as HTMLElement).closest("[data-win]")) void openWindow(ctx, "plain", project);
  };
  if (d.kind === "gm") {
    const docs = chaptersShown(s);
    const key = `plain|${verticalShown(s)}|${docs.map((x) => `${x.path}:${html.has(x.path) ? html.get(x.path)!.length : x.saved.length}`).join()}|${note}`;
    if (key === lastKey && body.querySelector(".pview")) return;
    lastKey = key;
    if (project && docs.some((x) => !html.has(x.path)) && !hb?.busy && !hb?.error) void buildHtml(ctx, project, docs.map((x) => x.path));
    // several chapters open: written horizontally (docs/adr/0006), and so is their text
    return renderPlain(body, sectionsOf(docs), verticalShown(s));
  }
  const key = `${d.kind}|${s.vertical}|${d.path}|${d.text}|${markdownHook.version}`;
  if (key === lastKey && body.querySelector(".pview")) return;
  lastKey = key;
  if (d.kind === "md") return void renderMarkdown(body, d.text, s.vertical, d.path);
  if (d.kind === "svg") return renderSvg(body, d.text);
  if (d.kind === "mmd") return void renderMermaid(body, d.text);
};

const sectionsOf = (docs: Doc[]) => docs.map((x) => ({ title: stem(x.path), html: html.get(x.path) ?? plainHtml(x.saved) }));

const drawPages = (head: HTMLElement, body: HTMLElement, ctx: Ctx, doc: Doc, s: State) => {
  const project = doc.project;
  if (!project) {
    head.innerHTML = headLeft(s, ctx, doc);
    head.onclick = (e) => void modeClick(ctx, e);
    lastKey = "";
    return renderHint(body, "Golem のプロジェクトの章で使えます");
  }
  const p = pages.get(project);
  const busy = pageBuilds.get(project)?.busy ?? false;
  const note = busy ? (p ? "組みなおしています…" : "組んでいます…") : waiter.waiting(project) ? "入力が止まったら組みなおします" : p && !p.ok ? "組めませんでした" : "";
  head.innerHTML = `${headLeft(s, ctx, doc)}${note ? `<small class="${p && !p.ok && !busy ? "ng" : ""}">${esc(note)}</small>` : ""}<span class="sp"></span>${zoomControls(zoom)}<span class="iconbtn" data-act="build" title="組みなおす">${icon(
    "refresh-cw",
    14,
  )}</span><span class="iconbtn" data-win="pages" title="別のウィンドウに出す">${icon("external-link", 14)}</span>`;
  head.onclick = (e) => {
    if (modeClick(ctx, e)) return;
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
  ctx.refresh(["previewTab"]);
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
    // a hidden preview tab has no width: nothing is drawn again until it is shown (docs/adr/0087)
    resizeTimer = window.setTimeout(() => body.clientWidth > 0 && body.isConnected && sharpen(ctx, project), 300);
  });
  resize.observe(body);
};

// ---- other windows ----

const sendPlain = async (ctx: Ctx) => {
  const s = ctx.store.get();
  await emit("aleph:plain", { sections: sectionsOf(chaptersShown(s)), vertical: verticalShown(s) }).catch(() => {});
};

export const openWindow = async (ctx: Ctx, view: "plain" | "pages", project: string) => {
  const label = `${view}-${Math.abs([...project].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7))}`;
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) return void existing.setFocus();
  const w = new WebviewWindow(label, {
    url: `index.html?view=${view}&project=${encodeURIComponent(project)}`,
    title: `${view === "pages" ? "ページ" : "本文"} — ${basename(project)}`,
    width: 620,
    height: 820,
  });
  w.once("tauri://error", (e) => ctx.notify({ message: `ウィンドウを開けません：${String(e.payload)}`, level: "error", sticky: true }));
};

// ---- PDF and images in place of the editor ----

/** A PDF: shem first (the subset Golem writes), the WebView's viewer otherwise. */
const pdfView = (el: HTMLElement, doc: Doc, ctx: Ctx): Editor => {
  const pane = document.createElement("div");
  pane.className = "pbody";
  el.append(pane);
  const draw = () => {
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
  };
  draw();
  // drawn again when the file changes outside (docs/adr/0063)
  return stubEditor(() => pane.remove(), undefined, draw);
};

const imageView = (el: HTMLElement, doc: Doc): Editor => {
  const pane = document.createElement("div");
  pane.className = "pbody";
  el.append(pane);
  void renderImage(pane, doc.path);
  return stubEditor(() => pane.remove(), undefined, () => void renderImage(pane, doc.path));
};

export const mountPreview = (ctx: Ctx) => {
  ctx.view.previewTab = (head, body) => {
    const d = shownDoc(ctx.store.get());
    if (d?.project && !styles.has(d.project)) void inchesOf(d.project).then(() => ctx.refresh(["previewTab"]));
    drawTab(head, body, ctx);
  };
  ctx.kindViews.pdf = pdfView;
  for (const k of IMAGE_KINDS) ctx.kindViews[k] = (el, doc) => imageView(el, doc);

  // after a save: the text is built again; the pages too when the setting says so, once the input has stopped (docs/adr/0056)
  ctx.store.subscribe((s, prev, action) => {
    if (action.type === "saved") {
      const before = allDocs(prev).find((d) => d.path === action.path);
      if (before?.project) {
        const project = before.project;
        const previewTab = s.panes.some((p) => p.tabs.some((t) => t.preview));
        const eligible = rebuildPagesOnSave({ setting: ctx.config.rebuildOnSave, kind: before.kind, hasPages: pages.has(project), previewTab, mode: s.previewMode });
        pageSaves.saved(project, action, before.saved, eligible, () => void buildPages(ctx, project, false, undefined, true));
        if (waiter.waiting(project)) ctx.refresh(["previewTab"]);
      }
    }
    for (const d of allDocs(s)) {
      const before = allDocs(prev).find((x) => x.path === d.path);
      if (before && d.project && before.text !== d.text) waiter.edited(d.project);
      if (!before || before.saved === d.saved) continue;
      if (d.path.endsWith("/style.toml")) styles.delete(d.project ?? "");
      if (!d.project) continue;
      if (d.kind === "gm") void buildHtml(ctx, d.project, chaptersShown(s).map((x) => x.path));
    }
    if (s.vertical !== prev.vertical || s.open !== prev.open || s.followed !== prev.followed) void sendPlain(ctx);
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
