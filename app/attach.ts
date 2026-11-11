// The right panel's attachments and outline, the counts in the status bar, and
// the characters and goal rings in the tree (docs/adr/0012).
import { api } from "./api.ts";
import { countText, type Stats } from "./count.ts";
import type { Ctx } from "./ctx.ts";
import { esc } from "./esc.ts";
import { gmBlocks } from "./gm.ts";
import { forgetManifest, loadManifest, separatorOf } from "./separator.ts";
import { addKeyword, collectKeywords, removeKeyword, suggest } from "./keywords.ts";
import { goalOf, metaFor, parseMeta, renameKey, writeMeta, type Meta } from "./notes.ts";
import { dirname, rel } from "./path.ts";
import { linesCell, namesCell, rowsFor, targetFor } from "./plot/data.ts";
import { plotRows, plotRowsNow } from "./plot/mount.ts";
import { allDocs, focused } from "./store.ts";
import { item } from "./ui/settings.ts";
import { kindOf, projectOf, workspaceOf } from "./workspace.ts";

// ---- where a sheet's metadata lives ----

/** The root whose .aleph/notes.json holds the sheet's metadata: its project, else its workspace. */
const rootOf = (ctx: Ctx, path: string): string | null =>
  allDocs(ctx.store.get()).find((doc) => doc.path === path)?.project ?? projectOf(path, ctx.projects) ?? workspaceOf(path, ctx.store.get().workspaces);

const metas = new Map<string, Meta>();
const pendingMetaSaves = new Map<string, number>();
const writingMeta = new Set<Promise<void>>();
/** A root's metadata, read once (the keywords panel shares it, docs/adr/0028). */
export const loadMeta = async (root: string) => {
  if (!metas.has(root)) metas.set(root, parseMeta(await api.readText(`${root}/.aleph/notes.json`).catch(() => "")));
  return metas.get(root)!;
};
/** Replaces a root's metadata and writes it. */
export const putMeta = async (root: string, m: Meta) => {
  metas.set(root, m);
  await saveMeta(root);
};
const saveMeta = (root: string) => {
  const write = (async () => {
    await api.makeDir(`${root}/.aleph`).catch(() => {});
    await api.writeText(`${root}/.aleph/notes.json`, writeMeta(metas.get(root) ?? {}));
  })();
  writingMeta.add(write);
  void write.then(() => writingMeta.delete(write), () => writingMeta.delete(write));
  return write;
};
const queueMetaSave = (root: string) => {
  clearTimeout(pendingMetaSaves.get(root));
  pendingMetaSaves.set(root, window.setTimeout(() => {
    pendingMetaSaves.delete(root);
    void saveMeta(root);
  }, 400));
};

// ---- counting, with each project's paragraph separator ----


const counts = new Map<string, number>();
const pending = new Set<string>();
let redraw = 0;

const count = (ctx: Ctx, kind: string, project: string | null, path: string, text: string): Stats =>
  countText(kind, text, ctx.config.manuscript, separatorOf(project, path, text));

/** The characters of a .gm in the tree: from the open sheet, else read once in the background. */
const charsOf = (ctx: Ctx, path: string): number | null => {
  const open = allDocs(ctx.store.get()).find((d) => d.path === path);
  if (open) return count(ctx, open.kind, open.project, path, open.text).chars;
  if (counts.has(path)) return counts.get(path)!;
  if (!pending.has(path)) {
    pending.add(path);
    void (async () => {
      const project = projectOf(path, ctx.projects);
      if (project) await loadManifest(project);
      counts.set(path, count(ctx, "gm", project, path, await api.readText(path).catch(() => "")).chars);
      pending.delete(path);
      clearTimeout(redraw);
      redraw = window.setTimeout(() => ctx.refresh(["left"]), 200);
    })();
  }
  return null;
};

const ring = (pct: number, size: number, stroke: number) => {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--bg-3)" stroke-width="${stroke}"/><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--accent)" stroke-width="${stroke}" stroke-dasharray="${
    Math.min(1, pct) * c
  } ${c}" transform="rotate(-90 ${size / 2} ${size / 2})"/></svg>`;
};

/** A sheet's goal: set by hand in its metadata, else the plot's planned characters. */
const goalFor = (ctx: Ctx, path: string) => {
  const root = rootOf(ctx, path);
  const m = root ? metas.get(root) : undefined;
  if (root && !metas.has(root)) void loadMeta(root).then(() => ctx.refresh(["left"]));
  const project = projectOf(path, ctx.projects);
  const rows = project ? plotRowsNow(project) : null;
  if (project && !rows) void plotRows(project).then(() => ctx.refresh(["left"]));
  return goalOf(m && root ? metaFor(m, rel(root, path)).goal : undefined, project && rows ? targetFor(rows, project, path) : null);
};

// ---- the panels ----

const KW_PERSON = "#7c93b3";
const KW_PLACE = "#8aa37f";
const KW_SUB = "#c9a862";

const drawAttach = async (el: HTMLElement, ctx: Ctx) => {
  const d = focused(ctx.store.get());
  if (!d) return void (el.innerHTML = `<div class="sec"><div class="muted">シートを開くと、目標、キーワード、書くこと、ノートがここに出ます。</div></div>`);
  const root = rootOf(ctx, d.path);
  if (!root) return void (el.innerHTML = `<div class="sec"><div class="muted">ワークスペースの外のシートです。</div></div>`);
  if (d.project) await loadManifest(d.project);
  const meta = await loadMeta(root);
  const key = rel(root, d.path);
  const m = metaFor(meta, key);
  const rows = d.project ? rowsFor(await plotRows(d.project), d.project, d.path) : [];
  const st = count(ctx, d.kind, d.project, d.path, d.text);
  const g = goalOf(m.goal, d.project ? targetFor(rows, d.project, d.path) : null);
  const kws = [
    ...rows.flatMap((r) => namesCell(r.pov).map((v) => [`視点：${v}`, KW_PERSON])),
    ...rows.flatMap((r) => namesCell(r.characters).map((v) => [v, KW_PERSON])),
    ...rows.flatMap((r) => namesCell(r.place).map((v) => [v, KW_PLACE])),
    ...rows.flatMap((r) => namesCell(r.subplots).map((v) => [v, KW_SUB])),
  ].filter(([v], i, a) => a.findIndex(([w]) => w === v) === i);
  const musts = [...new Set(rows.flatMap((r) => linesCell(r.must)))];
  const flavors = rows.flatMap((r) => linesCell(r.flavor));
  const frags = rows.flatMap((r) => linesCell(r.fragments));
  const memos = rows.map((r) => r.memo.trim()).filter(Boolean);
  const prose = ["gm", "md", "txt"].includes(d.kind);
  el.innerHTML = `
    ${prose ? `<div class="sec"><h5>目標 <small>${g.from === "hand" ? "手で決めた値" : g.from === "plot" ? "プロットの予定字数" : ""}</small></h5>
      <div class="goal">${ring(g.goal ? st.chars / g.goal : 0, 44, 5)}
        <div class="t"><b>${st.chars.toLocaleString()}</b> / <input class="field" data-goal type="number" min="0" step="100" value="${m.goal ?? ""}" placeholder="${g.from === "plot" ? g.goal : "—"}"> 字<br>${
          g.goal ? `残り ${Math.max(0, g.goal - st.chars).toLocaleString()} 字 · ` : ""
        }原稿用紙 ${st.sheets} 枚</div>
      </div></div>` : ""}
    <div class="sec"><h5>キーワード</h5>
      <div class="kw mine">${(m.keywords ?? []).map((v) => `<span>${esc(v)}<i data-kw-rm="${esc(v)}" title="外す">×</i></span>`).join("")}<input class="field kwin" data-kw-add list="kw-cands" placeholder="足す（↩）"><datalist id="kw-cands">${suggest(
        collectKeywords([{ root, meta }]),
        "",
      )
        .filter((k) => !(m.keywords ?? []).includes(k))
        .map((k) => `<option value="${esc(k)}">`)
        .join("")}</datalist></div>
      ${kws.length ? `<h6>プロットから</h6><div class="kw">${kws.map(([v, c]) => `<span style="--c:${c}">${esc(v)}</span>`).join("")}</div>` : ""}</div>
    ${
      musts.length || flavors.length
        ? `<div class="sec"><h5>書くこと <small>${rows.map((r) => esc(r.scene)).filter(Boolean).join("、")}</small></h5><div class="todo">${musts
            .map((x) => `<label class="${m.done.includes(x) ? "done" : ""}"><input type="checkbox" data-must="${esc(x)}" ${m.done.includes(x) ? "checked" : ""}>${esc(x)}</label>`)
            .join("")}</div>${flavors.length ? `<div class="flavor">フレーバー：${flavors.map(esc).join("、")}</div>` : ""}</div>`
        : ""
    }
    ${
      memos.length || frags.length
        ? `<div class="sec"><h5>プロットのメモと断片</h5>${memos.map((x) => `<div class="memo">${esc(x)}</div>`).join("")}${frags.map((x) => `<div class="fragment">${esc(x)}</div>`).join("")}</div>`
        : ""
    }
    <div class="sec"><h5>ノート</h5><textarea class="note" data-note placeholder="このシートのメモ">${esc(m.note)}</textarea></div>`;
  const update = (f: (x: typeof m) => typeof m) => {
    meta[key] = f(metaFor(meta, key));
    queueMetaSave(root);
  };
  el.oninput = (e) => {
    const x = e.target as HTMLInputElement;
    if (x.dataset.note !== undefined) update((v) => ({ ...v, note: x.value }));
    else if (x.dataset.goal !== undefined) update((v) => ({ ...v, goal: Number(x.value) > 0 ? Number(x.value) : undefined }));
  };
  el.onkeydown = (e) => {
    const x = e.target as HTMLInputElement;
    if (x.dataset.kwAdd === undefined || e.key !== "Enter" || e.isComposing) return;
    e.preventDefault();
    meta[key] = { ...metaFor(meta, key), keywords: addKeyword(metaFor(meta, key).keywords ?? [], x.value) };
    void saveMeta(root).then(() => ctx.refresh(["right", "left"]));
  };
  el.onclick = (e) => {
    const k = (e.target as HTMLElement).closest<HTMLElement>("[data-kw-rm]")?.dataset.kwRm;
    if (k === undefined) return;
    meta[key] = { ...metaFor(meta, key), keywords: removeKeyword(metaFor(meta, key).keywords ?? [], k) };
    void saveMeta(root).then(() => ctx.refresh(["right", "left"]));
  };
  el.onchange = (e) => {
    const x = e.target as HTMLInputElement;
    if (x.dataset.must !== undefined) {
      const k = x.dataset.must;
      update((v) => ({ ...v, done: x.checked ? [...v.done.filter((d) => d !== k), k] : v.done.filter((d) => d !== k) }));
      x.closest("label")?.classList.toggle("done", x.checked);
    } else if (x.dataset.goal !== undefined) ctx.refresh(["right", "left"]);
  };
};

const drawOutline = (el: HTMLElement, ctx: Ctx) => {
  const d = focused(ctx.store.get());
  if (!d) return void (el.innerHTML = "");
  const heads =
    d.kind === "gm"
      ? gmBlocks(d.text).flatMap((b) => (b.kind === "h" ? [{ level: b.level, text: b.text, line: b.line }] : []))
      : d.kind === "md"
        ? d.text.split("\n").flatMap((l, i) => {
            const m = /^\s{0,3}(#{1,6})\s+(.*?)(\s+#+)?\s*$/.exec(l);
            return m ? [{ level: m[1].length, text: m[2], line: i }] : [];
          })
        : [];
  el.innerHTML = `<div class="sec"><h5>アウトライン</h5><div class="outline">${
    heads.map((x) => `<div data-l="${x.line + 1}" style="padding-left:${(x.level - 1) * 14 + 6}px">${esc(x.text)}</div>`).join("") || `<div class="muted">見出しがありません</div>`
  }</div></div>`;
  el.onclick = (e) => {
    const l = (e.target as HTMLElement).closest<HTMLElement>("[data-l]")?.dataset.l;
    if (l) ctx.editors.get(d.path)?.goto(Number(l));
  };
};

export const mountAttach = (ctx: Ctx) => {
  ctx.beforeRename.push(async () => {
    await Promise.all([...writingMeta]);
    const roots = [...pendingMetaSaves.keys()];
    for (const root of roots) clearTimeout(pendingMetaSaves.get(root));
    pendingMetaSaves.clear();
    await Promise.all(roots.map(saveMeta));
  });
  ctx.right.attach = { icon: "paperclip", title: "添付", render: (el) => drawAttach(el, ctx) };
  ctx.right.outline = { icon: "list", title: "アウトライン", render: (el) => drawOutline(el, ctx) };

  ctx.status.push((s) => {
    const d = focused(s);
    if (!d || !["gm", "md", "txt"].includes(d.kind)) return "";
    const st = count(ctx, d.kind, d.project, d.path, d.text);
    return `<span>${st.chars.toLocaleString()} 字</span><span>${st.words.toLocaleString()} 語</span><span>原稿用紙 ${st.sheets} 枚</span>`;
  });

  // the tree: characters of each .gm, and a ring for sheets with a goal
  ctx.decor.push((p) => {
    if (kindOf(p) !== "gm") return "";
    const chars = charsOf(ctx, p);
    if (chars === null) return "";
    const g = goalFor(ctx, p);
    return `<span class="cnt">${chars.toLocaleString()}</span>${g.goal ? `<span class="ring" title="${chars.toLocaleString()} / ${g.goal.toLocaleString()} 字">${ring(chars / g.goal, 12, 2.5)}</span>` : ""}`;
  });

  // counts follow saves; a saved manifest changes the separators
  ctx.store.subscribe((s, prev) => {
    for (const d of allDocs(s)) {
      const before = allDocs(prev).find((x) => x.path === d.path);
      if (!before || before.saved === d.saved) continue;
      counts.delete(d.path);
      if (d.path.endsWith("/manifest.toml")) {
        forgetManifest(dirname(d.path));
        counts.clear();
      }
    }
  });

  // A renamed sheet or folder keeps its metadata. A project carries notes.json with it.
  ctx.onRename.push(async (from, to, c) => {
    const roots = c.projects.filter((project) => project === from || project.startsWith(`${from}/`));
    if (roots.length) {
      for (const oldRoot of roots) {
        const newRoot = to + oldRoot.slice(from.length);
        const meta = metas.get(oldRoot);
        if (meta) metas.set(newRoot, meta);
        metas.delete(oldRoot);
        if (pendingMetaSaves.has(oldRoot)) {
          clearTimeout(pendingMetaSaves.get(oldRoot));
          pendingMetaSaves.delete(oldRoot);
          queueMetaSave(newRoot);
        }
      }
      if (roots.includes(from)) return;
    }
    const root = rootOf(c, from);
    if (!root || rootOf(c, to) !== root) return;
    const m = await loadMeta(root);
    const next = renameKey(m, rel(root, from), rel(root, to));
    if (next === m) return;
    metas.set(root, next);
    await saveMeta(root);
    counts.delete(from);
  });

  ctx.settings.push({
    id: "counting",
    label: "数え方",
    group: "オプション",
    render: (c) =>
      item(
        "原稿用紙の換算",
        "字 × 行。段落ごとに字数を 1 行の字数で割って切り上げた行数を足し、1 枚の行数で割る",
        `<input class="field num" type="number" min="5" max="60" data-ms="cols" value="${c.config.manuscript.cols}"> × <input class="field num" type="number" min="5" max="60" data-ms="rows" value="${c.config.manuscript.rows}">`,
      ),
    onChange: async (el, c) => {
      const k = el.dataset.ms as "cols" | "rows" | undefined;
      if (!k) return false;
      c.config.manuscript = { ...c.config.manuscript, [k]: Number(el.value) || 20 };
      await c.saveConfig();
      c.refresh(["status", "right"]);
      return true;
    },
  });
};

