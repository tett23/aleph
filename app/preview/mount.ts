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
import { manifestChapters } from "../manifest.ts";
import { readGrid } from "../workspace.ts";
import { previewKey, type PreviewTarget } from "./update.ts";
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
  prepareMarkdown,
  preparePages,
  preparePlain,
  previewPane,
  renderMermaid,
  renderPageImages,
  renderSvg,
  saveZoom,
  zoomByClick,
  zoomControls,
} from "./render.ts";
import { xhtmlPath } from "./xhtml.ts";
import { chapterBody } from "./xhtmldom.ts";

// ---- builds ----

/** Golem's HTML of a chapter, with its images as absolute paths in data-src. */
const html = new Map<string, string | null>();
type HtmlBuild = { busy: boolean; queued: string[] | null; error: string };
const htmlBuilds = new Map<string, HtmlBuild>();

/** The pages of a project: PNG files drawn by shem from the PDF golem built. */
export type Pages = { pdf: string; pngs: string[]; dpi: number; ok: boolean; log: string };
export type PreviewNotice = { target: PreviewTarget; generation: number };
export type PlainNotice = PreviewNotice & { sections?: ReturnType<typeof sectionsOf>; error?: string };
export type PagesNotice = PreviewNotice & { pages?: Pages; error?: string };
const pages = new Map<string, PagesNotice>();
const lastGoodPages = new Map<string, { pages: Pages; slot: number }>();
type PageRequest = { redraw: boolean; dpi: number; onlyChanged: boolean; generation: number; workspace: string };
type PageBuild = { running: boolean; queued: PageRequest | null; generation: number; published: number };
const pageBuilds = new Map<string, PageBuild>();
let generation = 0;
const nextGeneration = () => ++generation;

const out = (o: { stdout: string; stderr: string }) => (o.stderr || o.stdout).trim();

const buildHtml = async (ctx: Ctx, project: string, paths: string[]) => {
  const b = htmlBuilds.get(project) ?? { busy: false, queued: null, error: "" };
  htmlBuilds.set(project, b);
  if (b.busy) {
    b.queued = paths;
    return;
  }
  b.busy = true;
  b.error = "";
  ctx.refresh(["previewTab"]);
  void sendPlain(ctx);
  try {
    const result = await withBuildDir(project, async () => {
      const o = await golem(ctx, project, ["build", "--target", "html"]);
      if (o.code !== 0) throw new Error(out(o) || "golem build に失敗しました");
      const manifest = await api.readText(`${project}/manifest.toml`);
      const chapters = new Set(manifestChapters(manifest).map((path) => `${project}/${path}`));
      return Promise.all(paths.map(async (p) => {
        const x = xhtmlPath(project, p);
        const source = await api.readText(x).catch((error) => {
          if (chapters.has(p)) throw error;
          return null;
        });
        const body = source === null ? null : chapterBody(source, { dir: dirname(x), root: `${project}/build/html` });
        return [p, body?.html ?? null] as const;
      }));
    });
    if (!b.queued) for (const [path, content] of result) html.set(path, content);
  } catch (e) {
    b.error = String(e);
  }
  b.busy = false;
  if (b.queued) {
    const pending = b.queued;
    b.queued = null;
    void buildHtml(ctx, project, pending);
  } else {
    ctx.refresh(["previewTab"]);
    void sendPlain(ctx);
  }
};

/** The dpi the preview tab wants now: by its body's width, or 500 px when it has none (absent or hidden). */
const wantedDpi = (ctx: Ctx, project: string) => {
  const body = document.querySelector<HTMLElement>(".preview-tab .pbody");
  return autoDpi({ width: body?.clientWidth || 500, ratio: devicePixelRatio, zoom, inches: styles.get(project) ?? 148 / 25.4, fixed: ctx.config.dpi });
};

const hash = (value: string) => Math.abs([...value].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7));

const rasterize = async (ctx: Ctx, project: string, pdf: string, dpi: number, slot?: number): Promise<Pages> => {
  const name = slot === undefined ? `pdf-${hash(pdf)}-${dpi}` : `pages-${hash(project)}-${slot}`;
  const dir = await api.tempDir(name);
  const o = await shem(ctx, project, ["render", "--dpi", String(dpi), argPath(pdf), argPath(dir)]);
  const pngs = o.code === 0 ? (await api.listDir(dir)).filter((p) => p.endsWith(".png")).sort() : [];
  return { pdf, pngs, dpi, ok: o.code === 0 && pngs.length > 0, log: o.code === 0 ? "" : out(o) || "shem render に失敗しました" };
};

const publishPages = (ctx: Ctx, notice: PagesNotice) => {
  pages.set(notice.target.project, notice);
  ctx.refresh(["previewTab"]);
  void emit("aleph:pages", notice).catch(() => {});
};

// builds after a save wait until the input has stopped for 5 s (docs/adr/0056)
const waiter = createWaiter({ now: () => Date.now(), set: (fn, ms) => window.setTimeout(fn, ms), clear: (id) => clearTimeout(id) });
const pageSaves = createPageSaves(waiter);

/** golem build --target pdf, then shem; with redraw, only shem on the last built PDF. */
const buildPages = (ctx: Ctx, project: string, redraw = false, dpi = wantedDpi(ctx, project), onlyChanged = false, workspace = "") => {
  if (!redraw) waiter.cancel(project);
  const existing = pageBuilds.get(project);
  if (existing?.running && redraw) return;
  if (existing?.queued && !existing.queued.redraw && onlyChanged) return;
  if (onlyChanged && !pageSaves.inputsFor(project).changed()) return;
  const request: PageRequest = {
    redraw, dpi, onlyChanged, generation: nextGeneration(),
    workspace: workspace || allDocs(ctx.store.get()).find((doc) => doc.project === project)?.workspace || ctx.store.get().workspace || "",
  };
  const b = existing ?? { running: false, queued: null, generation: 0, published: 0 };
  pageBuilds.set(project, b);
  b.generation = request.generation;
  // Invalidate any pending image decode in the separate window immediately.
  // The next notification carries the new manifest's exact target.
  const before = pages.get(project);
  if (before?.target.workspace === request.workspace)
    void emit("aleph:pages", { target: before.target, generation: request.generation } satisfies PagesNotice).catch(() => {});
  if (b.running) {
    b.queued = request;
    ctx.refresh(["previewTab"]);
    return;
  }
  void runPages(ctx, project, b, request);
};

const runPages = async (ctx: Ctx, project: string, b: PageBuild, request: PageRequest) => {
  b.running = true;
  ctx.refresh(["previewTab"]);
  const { workspace, generation, redraw, dpi, onlyChanged } = request;
  const target: PreviewTarget = { workspace, project, paths: [], mode: "pages", vertical: false };
  const current = () => b.generation === generation;
  let noticeGeneration: number | undefined;
  const notify = (result: Pick<PagesNotice, "pages" | "error">) => {
    if (!current()) return;
    b.published = generation;
    noticeGeneration ??= nextGeneration();
    publishPages(ctx, { target: { ...target }, generation: noticeGeneration, ...result });
  };
  const inputs = pageSaves.inputsFor(project);
  try {
    const [manifest, style] = await Promise.all([api.readText(`${project}/manifest.toml`), api.readText(`${project}/style.toml`).catch(() => "")]);
    target.paths = manifestChapters(manifest).map((path) => `${project}/${path}`);
    target.vertical = readGrid(style).vertical;
    notify({});
    let snapshot: Map<string, string> | undefined;
    let pdf = redraw ? lastGoodPages.get(project)?.pages.pdf : undefined;
    if (!pdf) {
      const result = await withBuildDir(project, async () => {
        if (!current()) return null;
        if (onlyChanged && !inputs.changed()) return false;
        snapshot = inputs.snapshot();
        const o = await golem(ctx, project, ["build", "--target", "pdf"]);
        if (o.code !== 0) throw new Error(out(o) || "golem build に失敗しました");
        return (await api.listDir(`${project}/build/pdf`)).find((p) => p.endsWith(".pdf"));
      });
      if (result === null) return;
      if (result === false) {
        const previous = lastGoodPages.get(project);
        if (previous) notify({ pages: previous.pages });
        return;
      }
      if (!result) throw new Error("build/pdf に PDF がありません");
      pdf = result;
    }
    if (!current()) return;
    const slot = lastGoodPages.get(project)?.slot === 0 ? 1 : 0;
    const result = await rasterize(ctx, project, pdf, dpi, slot);
    if (!result.ok) throw new Error(result.log || "ページ画像がありません");
    if (!current()) return;
    lastGoodPages.set(project, { pages: result, slot });
    if (snapshot) inputs.publish(snapshot);
    notify({ pages: result });
  } catch (e) {
    notify({ error: String(e) });
  } finally {
    b.running = false;
    if (b.queued) {
      const next = b.queued;
      b.queued = null;
      void runPages(ctx, project, b, next);
    } else ctx.refresh(["previewTab"]);
  }
};

// ---- the preview tab ----

let zoom = loadZoom();
type TabPreview = {
  revision: string;
  updates: ReturnType<typeof previewPane>;
  controls: (() => void) | null;
  error: string;
};
const tabs = new WeakMap<HTMLElement, TabPreview>();
const tabPreview = (head: HTMLElement, body: HTMLElement, ctx: Ctx): TabPreview => {
  const existing = tabs.get(body);
  if (existing) return existing;
  const tab: TabPreview = {
    revision: "", controls: null, error: "",
    updates: previewPane(body, (error, empty) => {
      tab.error = String(error);
      if (empty) renderHint(body, tab.error, true);
      ctx.notify({ message: `プレビューの更新に失敗しました：${tab.error}`, level: "error" });
      const status = head.querySelector<HTMLElement>("[data-preview-status]");
      if (status) {
        status.textContent = "更新できませんでした";
        status.classList.add("ng");
      }
    }),
  };
  tabs.set(body, tab);
  return tab;
};
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

const plainTarget = (s: State, docs: Doc[], doc: Doc | null): PreviewTarget => ({
  workspace: doc?.workspace || s.workspace || "", project: doc?.project ?? "",
  paths: docs.map((d) => d.path), mode: "plain", vertical: verticalShown(s),
});

const drawTab = (head: HTMLElement, body: HTMLElement, ctx: Ctx) => {
  const s = ctx.store.get();
  const doc = shownDoc(s);
  const what = previewShows(doc, s.previewMode);
  const tab = tabPreview(head, body, ctx);
  if (what !== "pages") {
    tab.controls?.();
    tab.controls = null;
  }
  if (what === "none" || what === "empty" || (what === "pages" && !doc?.project)) {
    head.innerHTML = headLeft(s, ctx, doc);
    head.onclick = (e) => void modeClick(ctx, e);
    tab.revision = "";
    tab.error = "";
    tab.updates.reset();
    body.classList.remove("from-right");
    return renderHint(body, what === "pages" ? "Golem のプロジェクトの章で使えます" : previewMessage(what));
  }
  const d = doc!;
  if (what === "pages") return drawPages(head, body, ctx, d, s, tab);
  const project = d.project ?? "";
  const hb = htmlBuilds.get(project);
  const status = d.kind === "gm" && hb?.busy ? "組んでいます…" : tab.error ? "更新できませんでした" : "";
  head.innerHTML = `${headLeft(s, ctx, d)}<small class="${tab.error ? "ng" : ""}" data-preview-status>${status}</small><span class="sp"></span>${
    d.kind === "gm" ? `<span class="iconbtn" data-win="plain" title="別のウィンドウに出す">${icon("external-link", 14)}</span>` : ""
  }`;
  head.onclick = (e) => {
    if (modeClick(ctx, e)) return;
    if ((e.target as HTMLElement).closest("[data-win]")) void openWindow(ctx, "plain", project);
  };
  const docs = d.kind === "gm" ? chaptersShown(s) : [d];
  const target = plainTarget(s, docs, d);
  if (d.kind === "gm") {
    const sections = sectionsOf(docs);
    if (project && docs.some((x) => !html.has(x.path)) && !hb?.busy && !hb?.error) {
      void buildHtml(ctx, project, docs.map((x) => x.path));
      return;
    }
    updateTab(tab, target, JSON.stringify([sections, hb?.busy, hb?.error]), hb?.busy ? undefined : async () => {
      if (hb?.error) throw new Error(hb.error);
      return preparePlain(body, sections, target.vertical);
    }, head);
    return;
  }
  if (d.kind === "md") {
    updateTab(tab, target, JSON.stringify([d.text, markdownHook.version]), () => prepareMarkdown(body, d.text, target.vertical, d.path), head);
    return;
  }
  target.mode = "figure";
  updateTab(tab, target, d.text, async () => {
    const staging = document.createElement("div");
    if (d.kind === "svg") renderSvg(staging, d.text);
    else await renderMermaid(staging, d.text);
    const urls = [...staging.querySelectorAll("img")].map((img) => img.src);
    return {
      mount: () => { body.classList.remove("from-right"); body.replaceChildren(...staging.childNodes); },
      dispose: () => urls.forEach((url) => URL.revokeObjectURL(url)),
    };
  }, head);
};

type PreviewLoad = Parameters<ReturnType<typeof previewPane>["request"]>[2];
const updateTab = (tab: TabPreview, target: PreviewTarget, content: string, load: PreviewLoad | undefined, head: HTMLElement) => {
  const revision = JSON.stringify([previewKey(target), content]);
  if (revision === tab.revision) return;
  tab.revision = revision;
  tab.error = "";
  const status = head.querySelector<HTMLElement>("[data-preview-status]")!;
  status.classList.remove("ng");
  status.textContent = load ? "" : "組んでいます…";
  const generation = nextGeneration();
  if (load) void tab.updates.request(target, generation, load);
  else tab.updates.select(target, generation);
};

const sectionsOf = (docs: Doc[]) => docs.map((x) => ({ title: stem(x.path), html: html.get(x.path) ?? plainHtml(x.saved) }));

const drawPages = (head: HTMLElement, body: HTMLElement, ctx: Ctx, doc: Doc, s: State, tab: TabPreview) => {
  const project = doc.project!;
  const workspace = doc.workspace || s.workspace || "";
  const cached = pages.get(project);
  const notice = cached?.target.workspace === workspace ? cached : undefined;
  const busy = pageBuilds.get(project)?.running ?? false;
  const note = busy ? "組んでいます…" : waiter.waiting(project) ? "入力が止まったら組みなおします" : tab.error ? "更新できませんでした" : "";
  head.innerHTML = `${headLeft(s, ctx, doc)}<small class="${tab.error ? "ng" : ""}" data-preview-status>${note}</small><span class="sp"></span>${zoomControls(zoom)}<span class="iconbtn" data-act="build" title="組みなおす">${icon(
    "refresh-cw",
    14,
  )}</span><span class="iconbtn" data-win="pages" title="別のウィンドウに出す">${icon("external-link", 14)}</span>`;
  head.onclick = (e) => {
    if (modeClick(ctx, e)) return;
    const t = e.target as HTMLElement;
    const z = zoomByClick(t, zoom);
    if (z !== null) return setZoom(ctx, project, z);
    if (t.closest("[data-act=build]")) return buildPages(ctx, project);
    if (t.closest("[data-win]")) void openWindow(ctx, "pages", project);
  };
  tab.controls?.();
  const detach = onWheelZoom(body, () => zoom, (z) => setZoom(ctx, project, z));
  const unwatch = watchWidth(ctx, body, project);
  tab.controls = () => { detach(); unwatch(); };
  body.querySelector<HTMLElement>(".pview.pages")?.style.setProperty("--zoom", String(zoom));
  const target = notice?.target ?? { workspace, project, paths: [], mode: "pages", vertical: false };
  const data = notice?.pages;
  const building = pageBuilds.get(project);
  if (!notice || (building?.published !== building?.generation && busy)) {
    updateTab(tab, target, "pending", undefined, head);
    if (!body.firstElementChild) renderHint(body, "組んでいます…");
    if (!busy) buildPages(ctx, project, false, undefined, false, workspace);
    return;
  }
  updateTab(tab, target, JSON.stringify([notice.generation, notice.error, !!data]), notice.error || data ? async () => {
    if (notice.error) throw new Error(notice.error);
    return preparePages(body, data!.pngs, () => zoom);
  } : undefined, head);
  if (!body.firstElementChild) renderHint(body, "組んでいます…");
};

const setZoom = (ctx: Ctx, project: string, z: number) => {
  zoom = z;
  saveZoom(z);
  ctx.refresh(["previewTab"]);
  sharpen(ctx, project);
};

/** Draws the PDF again with shem when the pane needs more pixels than the pages have. */
const sharpen = (ctx: Ctx, project: string) => {
  const p = pages.get(project)?.pages;
  if (pageBuilds.get(project)?.running || !p?.ok || ctx.config.dpi > 0) return;
  const want = wantedDpi(ctx, project);
  if (want > p.dpi) void buildPages(ctx, project, true, want);
};

const watchWidth = (ctx: Ctx, body: HTMLElement, project: string) => {
  let timer = 0;
  const resize = new ResizeObserver(() => {
    clearTimeout(timer);
    timer = window.setTimeout(() => body.clientWidth > 0 && body.isConnected && sharpen(ctx, project), 300);
  });
  resize.observe(body);
  return () => { clearTimeout(timer); resize.disconnect(); };
};

// ---- other windows ----

let plainRevision = "";
const sendPlain = async (ctx: Ctx, force = false) => {
  const s = ctx.store.get();
  const docs = chaptersShown(s);
  const focused = shownDoc(s);
  const target = plainTarget(s, docs, focused);
  const build = htmlBuilds.get(target.project);
  const notice: Omit<PlainNotice, "generation"> = { target };
  if (build?.error && !build.busy) notice.error = build.error;
  else if (!build?.busy) notice.sections = sectionsOf(docs);
  const revision = JSON.stringify(notice);
  if (!force && revision === plainRevision) return;
  plainRevision = revision;
  await emit("aleph:plain", { ...notice, generation: nextGeneration() } satisfies PlainNotice).catch(() => {});
};

export const openWindow = async (ctx: Ctx, view: "plain" | "pages", project: string) => {
  const s = ctx.store.get();
  const workspace = shownDoc(s)?.workspace || s.workspace || "";
  const label = `${view}-${hash(JSON.stringify([workspace, project]))}`;
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) return void existing.setFocus();
  const w = new WebviewWindow(label, {
    url: `index.html?view=${view}&project=${encodeURIComponent(project)}&workspace=${encodeURIComponent(workspace)}`,
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
  ctx.view.pausePreviewTab = (body) => {
    const tab = tabs.get(body);
    if (!tab) return;
    tab.revision = "";
    tab.updates.pause();
    tab.controls?.();
    tab.controls = null;
  };
  ctx.view.closePreviewTab = (body) => {
    const tab = tabs.get(body);
    tab?.updates.close();
    tab?.controls?.();
    tabs.delete(body);
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
        const eligible = rebuildPagesOnSave({ setting: ctx.config.rebuildOnSave, kind: before.kind, hasPages: lastGoodPages.has(project), previewTab, mode: s.previewMode });
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
      if (d.kind === "gm") {
        const paths = chaptersShown(s).filter((x) => x.project === d.project).map((x) => x.path);
        void buildHtml(ctx, d.project, [...new Set([...paths, d.path])]);
      }
    }
    if (s.vertical !== prev.vertical || s.open !== prev.open || s.followed !== prev.followed) void sendPlain(ctx);
  });

  // the preview windows ask for what they show, and for a sharper drawing
  void listen("aleph:plain-want", () => void sendPlain(ctx, true));
  void listen<{ project: string; workspace: string; dpi?: number }>("aleph:pages-want", (e) => {
    const { project, workspace, dpi } = e.payload;
    const notice = pages.get(project);
    const p = notice?.pages;
    const building = pageBuilds.get(project);
    if (building?.running) {
      if (building.published === building.generation && notice?.target.workspace === workspace)
        void emit("aleph:pages", notice).catch(() => {});
      return;
    }
    if (!notice || notice.target.workspace !== workspace) return buildPages(ctx, project, false, dpi, false, workspace);
    if (notice.pages && dpi && p && dpi > p.dpi && ctx.config.dpi === 0) return buildPages(ctx, project, true, dpi, false, workspace);
    void emit("aleph:pages", notice).catch(() => {});
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
