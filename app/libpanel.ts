// The shared library in the app (docs/adr/0014): the cross-project panel on the
// left, the open project's on the right, files dropped on them, fonts copied to
// projects, and images dropped on the editor; files and folders dropped on the tree (docs/adr/0078).
import { addCommands } from "./commands.ts";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { api } from "./api.ts";
import { adopt } from "./config.ts";
import type { Ctx } from "./ctx.ts";
import { copyWithProgress, dropTarget, type Hit, type Progress } from "./dropin.ts";
import { esc } from "./esc.ts";
import { icon } from "./icons.ts";
import { FIGURE_KINDS, copyFonts, figureInsert, freeName, installItem, libSubdir, libraryFiles, stateOf, targetIn, type Fs, type LibFile, type LibState } from "./library.ts";
import { basename, rel } from "./path.ts";
import { allDocs, focused } from "./store.ts";
import { confirmDialog } from "./ui/dom.ts";
import { item } from "./ui/settings.ts";
import { reloadTree } from "./ui/tree.ts";
import { workspaceOf } from "./workspace.ts";

const fs: Fs = {
  exists: api.exists,
  readBytes: api.readBytes,
  readText: api.readText,
  writeText: api.writeText,
  copyFile: api.copyFile,
  listDir: api.listDir,
};

const LABEL = { font: ["フォント", "type"], plugin: ["プラグイン", "puzzle"], function: ["関数", "sigma"] } as const;
const MARK: Record<LibState, [string, string]> = {
  same: ["check", "同じものが入っている"],
  changed: ["triangle-alert", "中身が違う（押すと共有ライブラリのもので上書きする）"],
  absent: ["plus", "入っていない（押すと入れる）"],
};

const dropzone = `<div class="dropzone">.wasm、.emet、フォントとライセンスをここにドロップすると、<br>共有ライブラリの plugins/、functions/、fonts/ にコピーします。</div>`;

const projectName = (ctx: Ctx, p: string) => {
  const ws = workspaceOf(p, ctx.config.workspaces);
  return ctx.config.workspaces.length > 1 && ws ? `${basename(ws)} / ${rel(ws, p)}` : ws ? rel(ws, p) : basename(p);
};

/** Installs `f` into each project; asks first when some have different contents. */
const install = async (ctx: Ctx, f: LibFile, targets: { project: string; state: LibState }[]) => {
  const todo = targets.filter((t) => t.state !== "same");
  if (!todo.length) return false;
  const changed = todo.filter((t) => t.state === "changed");
  if (changed.length && !(await confirmDialog(`${f.name} を、中身の違う ${changed.map((t) => projectName(ctx, t.project)).join("、")} で上書きします（Git で戻せます）`, "上書きする"))) return false;
  for (const t of todo) await installItem(fs, t.project, f);
  ctx.toast(`${f.name} を ${todo.length} 件のプロジェクトに入れました${f.kind === "plugin" ? "（manifest.toml に宣言を足しました）" : ""}`);
  await reloadTree(ctx);
  return true;
};

const states = async (ctx: Ctx, projects: string[]) => {
  const files = await libraryFiles(fs, ctx.config.libraryDir);
  return Promise.all(files.map(async (f) => ({ f, at: await Promise.all(projects.map(async (project) => ({ project, state: await stateOf(fs, f.from, targetIn(project, f)) }))) })));
};

const noLibrary = `<div class="sec"><div class="muted">設定の「共有ライブラリ」でフォルダを決めると、フォント、プラグイン、関数をすべてのプロジェクトにまたがって管理できます。</div></div>`;

const drawAll = async (el: HTMLElement, ctx: Ctx) => {
  if (!ctx.config.libraryDir) return void (el.innerHTML = noLibrary);
  el.innerHTML = `<div class="sec"><div class="muted">読んでいます…</div></div>`;
  const rows = await states(ctx, ctx.projects);
  el.innerHTML =
    `<div class="libhost">` +
    (["font", "plugin", "function"] as const)
      .map((k) => {
        const xs = rows.filter((x) => x.f.kind === k);
        return `<div class="libsec"><div class="libh">${icon(LABEL[k][1], 13)}${LABEL[k][0]}<small>${xs.length}</small></div>${
          xs
            .map(
              ({ f, at }) =>
                `<div class="libitem"><div class="libname" title="${esc(f.from)}">${esc(f.name)}${
                  at.some((a) => a.state !== "same") ? `<span class="btn tiny" data-all="${esc(f.from)}">すべてに入れる</span>` : ""
                }</div>${at
                  .map((a) => `<div class="libproj ${a.state}" ${a.state === "same" ? "" : `data-one="${esc(f.from)}" data-p="${esc(a.project)}"`} title="${MARK[a.state][1]}">${icon(MARK[a.state][0], 12)}<span>${esc(projectName(ctx, a.project))}</span></div>`)
                  .join("")}</div>`,
            )
            .join("") || `<div class="muted libempty">ありません</div>`
        }</div>`;
      })
      .join("") +
    `<div class="libsec">${dropzone}<div class="muted libnote">${esc(ctx.config.libraryDir)}<br>プロジェクトにはコピーして入れます。プラグインは manifest.toml に宣言も足します。</div></div></div>`;
  el.onclick = async (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>("[data-all],[data-one]");
    const row = t && rows.find((x) => x.f.from === (t.dataset.all ?? t.dataset.one));
    if (!t || !row) return;
    const targets = t.dataset.all ? row.at : row.at.filter((a) => a.project === t.dataset.p);
    if (await install(ctx, row.f, targets)) await drawAll(el, ctx);
  };
};

const drawProject = async (el: HTMLElement, ctx: Ctx) => {
  if (!ctx.config.libraryDir) return void (el.innerHTML = noLibrary);
  const project = focused(ctx.store.get())?.project;
  if (!project) return void (el.innerHTML = `<div class="sec"><div class="muted">Golem のプロジェクトのシートを開くと、そのプロジェクトでの状態が出ます。</div>${dropzone}</div>`);
  const rows = await states(ctx, [project]);
  const sec = (k: "font" | "plugin" | "function") =>
    `<div class="sec"><h5>${LABEL[k][0]}</h5>${
      rows
        .filter((x) => x.f.kind === k)
        .map(
          ({ f, at: [a] }) =>
            `<div class="libfile">${icon(LABEL[k][1], 14)}<span>${esc(f.name)}</span>${
              a.state === "same" ? `<span class="muted">入っています</span>` : `<span class="btn" data-i="${esc(f.from)}">${a.state === "changed" ? "上書きする" : "入れる"}</span>`
            }</div>`,
        )
        .join("") || `<div class="muted">ありません</div>`
    }${k === "function" ? `<div class="muted libnote">.gm からは <code>@import functions/名前.emet as 名前</code> で使います。</div>` : ""}</div>`;
  el.innerHTML = `<div class="libhost">${sec("plugin")}${sec("function")}${sec("font")}<div class="sec">${dropzone}</div></div>`;
  el.onclick = async (e) => {
    const from = (e.target as HTMLElement).closest<HTMLElement>("[data-i]")?.dataset.i;
    const row = rows.find((x) => x.f.from === from);
    if (row && (await install(ctx, row.f, row.at))) await drawProject(el, ctx);
  };
};

const fontsFor = async (ctx: Ctx, project: string, quiet = false) => {
  if (!ctx.config.libraryDir) return;
  const copied = await copyFonts(fs, ctx.config.libraryDir, project).catch(() => []);
  if (copied.length) ctx.toast(`共有ライブラリからフォントをコピーしました：${copied.map(basename).join("、")}`);
  else if (!quiet) ctx.toast("足りないフォントはありません");
};

// ---- dropping files ----

const dropIntoLibrary = async (ctx: Ctx, paths: string[]) => {
  if (!ctx.config.libraryDir) return ctx.toast("設定で共有ライブラリのフォルダを決めてください");
  const done: string[] = [];
  const skipped: string[] = [];
  for (const p of paths) {
    const sub = libSubdir(p);
    if (!sub) skipped.push(basename(p));
    else {
      await api.copyFile(p, `${ctx.config.libraryDir}/${sub}/${basename(p)}`);
      done.push(`${sub}/${basename(p)}`);
    }
  }
  ctx.toast([done.length ? `共有ライブラリにコピーしました：${done.join("、")}` : "", skipped.length ? `扱えないファイル：${skipped.join("、")}` : ""].filter(Boolean).join("\n"));
  ctx.refresh(["sidebar", "rightSidebar"]);
};

/** Copies files into a directory without overwriting; returns the new paths. */
const copyInto = async (dir: string, paths: string[]) => {
  const out: string[] = [];
  for (const p of paths) {
    const to = `${dir}/${await freeName(fs, dir, basename(p))}`;
    await api.copyFile(p, to);
    out.push(to);
  }
  return out;
};

const dropOnEditor = async (ctx: Ctx, path: string, paths: string[], x: number, y: number) => {
  const d = allDocs(ctx.store.get()).find((o) => o.path === path);
  const t = ctx.editors.get(path)?.edit;
  if (!d?.project || !t) return;
  const images = paths.filter((p) => FIGURE_KINDS.test(p));
  if (!images.length) return ctx.toast("落とせるのは PNG、JPEG、SVG、PDF の画像です");
  const copied = await copyInto(`${d.project}/images`, images);
  const pos = t.view.posAtCoords(x, y) ?? t.core.sel().head;
  const line = t.core.doc().lineAt(pos).number;
  const { at, insert } = figureInsert(t.core.text(), line, copied.map((p) => rel(d.project!, p)));
  t.apply([{ from: at, insert }], "input.drop");
  ctx.toast(`images/ にコピーし、@figure を差し込みました`);
  await reloadTree(ctx);
  ctx.refresh(["sidebar"]);
};

// ---- dropping on the tree (docs/adr/0078) ----

/** Where in the tree `el` is: a folder's or project's row, a file's row, or the tree without a row. */
const treeHit = (el: HTMLElement | null): Hit => {
  if (!el?.closest(".file-tree")) return null;
  const row = el.closest<HTMLElement>("[data-dir],[data-file]");
  if (row?.dataset.dir) return { kind: "dir", path: row.dataset.dir };
  if (row?.dataset.file) return { kind: "file", path: row.dataset.file };
  return { kind: "empty" };
};

/** Marks where a drop would go: the target's row and the rows in it, or the whole tree for the workspace. */
let marked: string | null = null;
const markTarget = (target: string | null, hit: Hit) => {
  const key = target && `${hit?.kind === "empty" ? "tree" : "rows"}:${target}`;
  if (key === marked) return;
  marked = key;
  document.querySelectorAll(".drop-into").forEach((e) => e.classList.remove("drop-into"));
  if (!target) return;
  if (hit?.kind === "empty") return void document.querySelector(".file-tree")?.classList.add("drop-into");
  for (const r of document.querySelectorAll<HTMLElement>(".file-tree [data-dir], .file-tree [data-file]")) {
    const p = r.dataset.dir ?? r.dataset.file ?? "";
    if (p === target || p.startsWith(`${target}/`)) r.classList.add("drop-into");
  }
};

/** The copies running, by the id Rust reports their progress with. */
const copies = new Map<number, (p: Progress) => void>();
let copySeq = 0;
let hearing: Promise<unknown> | null = null;
const hearProgress = () =>
  (hearing ??= listen<Progress & { id: number }>("aleph:copy-progress", (e) => copies.get(e.payload.id)?.(e.payload)).catch(() => {}));

/** Copies what was dropped into `dir`, off the main thread, with a toast if it takes a while. */
const dropIntoTree = async (ctx: Ctx, dir: string, paths: string[]) => {
  await hearProgress();
  const id = ++copySeq;
  const target = rel(ctx.store.get().workspace ?? "", dir) || basename(dir);
  await copyWithProgress({
    clock: { now: () => Date.now(), set: (fn, ms) => window.setTimeout(fn, ms), clear: (t) => clearTimeout(t) },
    notify: ctx.notify,
    key: `drop-copy-${id}`,
    target,
    run: (onProgress) => {
      copies.set(id, onProgress);
      return api.copyDropped(id, dir, paths).finally(() => copies.delete(id));
    },
  }).catch(() => {});
  await reloadTree(ctx);
  ctx.store.dispatch({ type: "expand", path: dir, on: true });
  ctx.refresh(["sidebar"]);
};

const mountDrops = (ctx: Ctx) => {
  const at = (p: { x: number; y: number }) => {
    const x = p.x / devicePixelRatio;
    const y = p.y / devicePixelRatio;
    return { x, y, el: document.elementFromPoint(x, y) as HTMLElement | null };
  };
  const overLibrary = (el: HTMLElement | null) => !!el?.closest(".libhost, .right-sidebar .rbody.library");
  void getCurrentWebview().onDragDropEvent(async (e) => {
    const right = document.querySelector<HTMLElement>(".right-sidebar");
    const p = e.payload;
    if (p.type === "leave") {
      markTarget(null, null);
      return void right?.classList.remove("drop-over");
    }
    const { x, y, el } = at(p.position);
    if (p.type === "over" || p.type === "enter") {
      const hit = treeHit(el);
      markTarget(dropTarget(hit, ctx.store.get().workspace), hit);
      return void right?.classList.toggle("drop-over", overLibrary(el));
    }
    markTarget(null, null);
    right?.classList.remove("drop-over");
    if (overLibrary(el)) return dropIntoLibrary(ctx, p.paths);
    // the editor of a .gm: images become figures
    const editor = el?.closest<HTMLElement>(".ed");
    if (editor) {
      const path = [...ctx.editors.entries()].find(([, ed]) => ed.edit?.view.root === editor)?.[0];
      if (path?.endsWith(".gm")) return dropOnEditor(ctx, path, p.paths, x, y);
    }
    // a folder of the tree, the folder of a file, or the workspace (docs/adr/0078)
    const dir = dropTarget(treeHit(el), ctx.store.get().workspace);
    if (dir) await dropIntoTree(ctx, dir, p.paths);
  });
};

export const mountLibrary = (ctx: Ctx) => {
  ctx.sidebar.library = { icon: "library-big", title: "共有ライブラリ", render: (el) => drawAll(el, ctx) };
  ctx.rightSidebar.library = { icon: "library-big", title: "このプロジェクトの共有ライブラリ", render: (el) => drawProject(el, ctx) };
  mountDrops(ctx);

  // new projects take their fonts from the library (made with golem new --no-fonts)
  ctx.onNewProject.push((project, c) => fontsFor(c, project, true));
  // a project's fonts are completed when one of its sheets is opened
  const seen = new Set<string>();
  ctx.store.subscribe((s) => {
    for (const d of allDocs(s))
      if (d.project && !seen.has(d.project)) {
        seen.add(d.project);
        void fontsFor(ctx, d.project, true);
      }
  });
  addCommands(ctx.commands, {
    id: "library.copyFonts",
    menu: true,
    label: "共有ライブラリのフォントをコピー",
    icon: "type",
    when: (s) => !!focused(s)?.project && !!ctx.config.libraryDir,
    run: (c) => fontsFor(c, focused(c.store.get())!.project!),
  });

  ctx.settings.push({
    id: "library",
    label: "共有ライブラリ",
    group: "Golem",
    render: (c) =>
      item(
        "共有ライブラリのフォルダ",
        c.config.libraryDir ? `${esc(c.config.libraryDir)}<br>fonts/、plugins/（.wasm）、functions/（.emet）を置く` : "fonts/、plugins/（.wasm）、functions/（.emet）を置くフォルダ",
        `<span class="btn" data-lib="pick">選ぶ</span><span class="btn" data-lib="make">作る</span>${c.config.libraryDir ? `<span class="btn" data-lib="clear">外す</span>` : ""}`,
      ),
    onClick: async (el, c) => {
      const k = el.closest<HTMLElement>("[data-lib]")?.dataset.lib;
      if (!k) return false;
      if (k === "clear") c.config.libraryDir = "";
      else {
        // Rust opens the dialog, makes the folders and keeps the path (docs/adr/0050)
        const written = await api.chooseLibrary(k === "make");
        if (!written) return false;
        adopt(c.config, written);
      }
      await c.saveConfig();
      c.refresh(["sidebar", "rightSidebar"]);
      return true;
    },
  });
};
