// The shared library in the app (docs/adr/0014): the cross-project panel on the
// left, the open project's on the right, files dropped on them, fonts copied to
// projects, and images dropped on the editor or the tree.
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { api } from "./api.ts";
import type { Ctx } from "./ctx.ts";
import { esc } from "./esc.ts";
import { icon } from "./icons.ts";
import { FIGURE_KINDS, copyFonts, figureInsert, freeName, installItem, libSubdir, libraryFiles, stateOf, targetIn, type Fs, type LibFile, type LibState } from "./library.ts";
import { basename, dirname, rel } from "./path.ts";
import { focused } from "./store.ts";
import { confirmDialog } from "./ui/dom.ts";
import { item } from "./ui/settings.ts";
import { reloadTree } from "./ui/tree.ts";

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

const dropzone = `<div class="dropzone">.wasm、.emet、フォントとライセンスをここに落とすと、<br>共有ライブラリの plugins/、functions/、fonts/ にコピーします。</div>`;

const projectName = (ctx: Ctx, p: string) => {
  const ws = ctx.config.workspaces.find((w) => p.startsWith(w + "/"));
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
  const rows = (await states(ctx, [project])).filter((x) => x.f.kind !== "font" || x.at[0].state !== "absent");
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
  ctx.refresh(["left", "right"]);
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
  const d = ctx.store.get().open.find((o) => o.path === path);
  const view = ctx.editors.get(path)?.view;
  if (!d?.project || !view) return;
  const images = paths.filter((p) => FIGURE_KINDS.test(p));
  if (!images.length) return ctx.toast("落とせるのは PNG、JPEG、SVG、PDF の画像です");
  const copied = await copyInto(`${d.project}/images`, images);
  const pos = view.posAtCoords({ x, y }) ?? view.state.selection.main.head;
  const line = view.state.doc.lineAt(pos).number;
  const { at, insert } = figureInsert(view.state.doc.toString(), line, copied.map((p) => rel(d.project!, p)));
  view.dispatch({ changes: { from: at, insert } });
  ctx.toast(`images/ にコピーし、@figure を差し込みました`);
  await reloadTree(ctx);
  ctx.refresh(["left"]);
};

const mountDrops = (ctx: Ctx) => {
  const at = (p: { x: number; y: number }) => {
    const x = p.x / devicePixelRatio;
    const y = p.y / devicePixelRatio;
    return { x, y, el: document.elementFromPoint(x, y) as HTMLElement | null };
  };
  const overLibrary = (el: HTMLElement | null) => !!el?.closest(".libhost, .right .rbody.library");
  void getCurrentWebview().onDragDropEvent(async (e) => {
    const right = document.querySelector<HTMLElement>(".right");
    const p = e.payload;
    if (p.type === "leave") return void right?.classList.remove("drop-over");
    const { x, y, el } = at(p.position);
    if (p.type === "over" || p.type === "enter") return void right?.classList.toggle("drop-over", overLibrary(el));
    right?.classList.remove("drop-over");
    if (overLibrary(el)) return dropIntoLibrary(ctx, p.paths);
    // the editor of a .gm: images become figures
    const editor = el?.closest<HTMLElement>(".cm-editor");
    if (editor) {
      const path = [...ctx.editors.entries()].find(([, ed]) => ed.view?.dom === editor)?.[0];
      if (path?.endsWith(".gm")) return dropOnEditor(ctx, path, p.paths, x, y);
    }
    // a folder of the tree, or the folder of a file
    const row = el?.closest<HTMLElement>("[data-dir],[data-file]");
    const dir = row?.dataset.dir ?? (row?.dataset.file ? dirname(row.dataset.file) : null);
    if (dir) {
      const copied = await copyInto(dir, p.paths);
      ctx.toast(`${rel(ctx.store.get().workspace ?? "", dir) || basename(dir)} にコピーしました：${copied.map(basename).join("、")}`);
      await reloadTree(ctx);
      ctx.store.dispatch({ type: "expand", path: dir, on: true });
      ctx.refresh(["left"]);
    }
  });
};

export const mountLibrary = (ctx: Ctx) => {
  ctx.left.library = { icon: "library-big", title: "共有ライブラリ", render: (el) => drawAll(el, ctx) };
  ctx.right.library = { icon: "library-big", title: "このプロジェクトの共有ライブラリ", render: (el) => drawProject(el, ctx) };
  mountDrops(ctx);

  // new projects take their fonts from the library (made with golem new --no-fonts)
  ctx.onNewProject.push((project, c) => fontsFor(c, project, true));
  // a project's fonts are completed when one of its sheets is opened
  const seen = new Set<string>();
  ctx.store.subscribe((s) => {
    for (const d of s.open)
      if (d.project && !seen.has(d.project)) {
        seen.add(d.project);
        void fontsFor(ctx, d.project, true);
      }
  });
  ctx.commands.push({
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
        const dir = (await openDialog({ directory: true, multiple: false, title: k === "make" ? "共有ライブラリを作る場所" : "共有ライブラリのフォルダ" })) as string | null;
        if (!dir) return false;
        const lib = k === "make" ? `${dir}/Aleph Library` : dir;
        if (k === "make") for (const sub of ["fonts", "plugins", "functions"]) await api.makeDir(`${lib}/${sub}`);
        c.config.libraryDir = lib;
      }
      await c.saveConfig();
      c.refresh(["left", "right"]);
      return true;
    },
  });
};
