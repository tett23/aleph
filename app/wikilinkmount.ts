// Wikilinks in the app (docs/adr/0027): the index of the workspace's Markdown
// links, the right panel's 「リンク」, the editor's colours, marks, ⌘-click and
// completion, the preview's links, and rewriting links when a file is renamed.
// The rules are in wikilink.ts.
import { api } from "./api.ts";
import type { Ctx } from "./ctx.ts";
import type { Diag } from "./ed/diag.ts";
import type { TextEditor } from "./ed/editor.ts";
import { esc } from "./esc.ts";
import { basename, rel } from "./path.ts";
import { sheetsOf } from "./quickopen.ts";
import { allDocs, focused } from "./store.ts";
import { confirmDialog } from "./ui/dom.ts";
import { reloadTree, treeEntries, treeReloaded } from "./ui/tree.ts";
import { backlinks, buildIndex, completeAt, findHeading, groupBacklinks, markMissing, outlinks, parseWikilinks, renameEdits, resolveLink, type Index, type Sheet, type Wikilink } from "./wikilink.ts";
import { IMAGE_KINDS, kindOf, TEXT_KINDS } from "./workspace.ts";
import { expandEmbeds } from "./embed.ts";
import { parseMarkdown } from "./md.ts";
import { markdownHook, plainHtml } from "./preview/render.ts";

let index: Index = { links: [] };
/** The Markdown sheets' texts: the editor's for open ones, the disk's for the rest. */
const texts = new Map<string, string>();
/** Texts of other sheets read for headings (cleared when the tree is read again). */
const others = new Map<string, string>();
let sheets: Sheet[] = [];
const editors = new Map<string, TextEditor>();

const wsOf = (ctx: Ctx) => ctx.store.get().workspace ?? "";

const textOf = (ctx: Ctx, path: string): string | null => ctx.editors.get(path)?.text() ?? texts.get(path) ?? others.get(path) ?? null;

/** A sheet's text, from the editor, the caches or the disk. */
const readText = async (ctx: Ctx, path: string) => {
  const t = textOf(ctx, path);
  if (t !== null) return t;
  const r = await api.readText(path).catch(() => "");
  others.set(path, r);
  return r;
};

const reindex = (ctx: Ctx) => {
  index = buildIndex(texts, sheets, wsOf(ctx));
  editors.forEach((t, path) => mark(ctx, path, t));
  const s = ctx.store.get();
  if (s.showRight && s.right === "links") ctx.refresh(["right"]);
};

/** Every Markdown sheet of the workspace read again, with the sheets the links can point at. */
const rebuild = async (ctx: Ctx) => {
  const ws = wsOf(ctx);
  // the text kinds, and the images an embed shows (docs/adr/0029)
  sheets = ws ? sheetsOf(treeEntries(), ws, ctx.titles).filter((s) => TEXT_KINDS.includes(kindOf(s.path)) || IMAGE_KINDS.includes(kindOf(s.path))) : [];
  others.clear();
  texts.clear();
  await Promise.all(sheets.filter((s) => s.path.endsWith(".md")).map(async (s) => texts.set(s.path, ctx.editors.get(s.path)?.text() ?? (await api.readText(s.path).catch(() => "")))));
  reindex(ctx);
};

/** The marks of a Markdown editor: the missing targets dotted, the diagnostics of missing, ambiguous or headings not found. */
const mark = (ctx: Ctx, path: string, t: TextEditor) => {
  const ws = wsOf(ctx);
  const text = t.core.text();
  const missing: { from: number; to: number; cls: string }[] = [];
  const diags: Diag[] = [];
  for (const l of parseWikilinks(text)) {
    const r = l.target ? resolveLink(l.target, path, sheets, ws) : { path, ambiguous: false };
    if (!r.path) {
      missing.push({ from: l.from, to: l.to, cls: "wl-missing" });
      diags.push({ from: l.from, to: l.to, severity: "warning", message: `リンクの行き先「${l.target}」が見つかりません`, source: "wikilink" });
      continue;
    }
    if (r.ambiguous) diags.push({ from: l.from, to: l.to, severity: "info", message: `「${l.target}」に当たるシートが複数あります。${rel(ws, r.path)} を開きます`, source: "wikilink" });
    if (l.heading) {
      const other = textOf(ctx, r.path);
      if (other !== null && findHeading(other, kindOf(r.path), l.heading) === null)
        diags.push({ from: l.from, to: l.to, severity: "warning", message: `見出し「${l.heading}」が ${basename(r.path)} にありません`, source: "wikilink" });
    }
  }
  t.setLayer("link", missing);
  t.setDiagnostics(diags, "wikilink");
};

/** Opens a link's target (at its heading), or offers to make a missing one beside the linking sheet. */
const follow = async (ctx: Ctx, from: string, l: Pick<Wikilink, "target" | "heading">) => {
  const ws = wsOf(ctx);
  const target = l.target ? resolveLink(l.target, from, sheets, ws).path : from;
  if (!target) {
    const name = l.target.replace(/\.md$/, "");
    const path = `${from.slice(0, from.lastIndexOf("/"))}/${name}.md`;
    if (!(await confirmDialog(`${name}.md を作りますか`, "作る"))) return;
    if (await api.exists(path)) return ctx.toast(`${basename(path)} はすでにあります`);
    await api.writeText(path, `# ${basename(name)}\n`);
    await reloadTree(ctx);
    ctx.refresh(["left"]);
    return ctx.open([path], { line: 1, col: 0 });
  }
  if (!l.heading) return ctx.open([target]);
  const line = findHeading(await readText(ctx, target), kindOf(target), l.heading);
  if (line === null) ctx.toast(`見出し「${l.heading}」が見つからないので、シートの先頭を開きます`);
  await ctx.open([target], { line: line ?? 1, col: 0 });
  // an editor already open does not take the pending caret
  ctx.editors.get(target)?.goto(line ?? 1, 0);
};

// ---- the right panel ----

const drawPanel = (el: HTMLElement, ctx: Ctx) => {
  const d = focused(ctx.store.get());
  const ws = wsOf(ctx);
  if (!d || !ws) return void (el.innerHTML = `<div class="empty">シートを開くと、そのシートを指すリンクを出します。</div>`);
  const row = (path: string, line: number, text: string, key: string, missing = false) =>
    `<div class="lk ${missing ? "missing" : ""}" ${key}>${esc(ctx.titles.get(path) ?? basename(path))} <span class="muted">${line} 行</span><small>${esc(text.trim().slice(0, 80))}</small></div>`;
  // by linking sheet (docs/adr/0038)
  const back = groupBacklinks(backlinks(index, d.path));
  const out = d.kind === "md" ? outlinks(index, d.path) : [];
  const groups = back.groups
    .map(
      (g) =>
        `<div class="lkg"><div class="lkh" data-lk-open="${esc(g.from)}" data-lk-line="1">${esc(ctx.titles.get(g.from) ?? basename(g.from))} <span class="muted">${g.count} 件</span></div>${g.lines
          .map((l) => `<div class="lk" data-lk-open="${esc(g.from)}" data-lk-line="${l.line}"><span class="muted">${l.line} 行</span><small>${esc(l.text.trim().slice(0, 80))}</small></div>`)
          .join("")}</div>`,
    )
    .join("");
  el.innerHTML = `<div class="links"><div class="sec"><h5>このシートを指すリンク（${back.sheets} シート、${back.links} 件）</h5>${groups || `<div class="empty">ありません</div>`}</div>${
    d.kind === "md"
      ? `<div class="sec"><h5>このシートから出るリンク（${out.length}）</h5>${
          out
            .map((o) =>
              o.to
                ? row(o.to, o.line, o.link.label ?? o.link.target + (o.link.heading ? ` > ${o.link.heading}` : ""), `data-lk-target="${esc(o.link.target)}" data-lk-heading="${esc(o.link.heading ?? "")}"`)
                : `<div class="lk missing" data-lk-target="${esc(o.link.target)}" data-lk-heading="">${esc(o.link.target)} <span class="muted">見つかりません</span><small>${o.line} 行</small></div>`,
            )
            .join("") || `<div class="empty">ありません</div>`
        }</div>`
      : ""
  }</div>`;
};

/** The embeds' targets of a Markdown text, resolved. */
const embedTargets = (ctx: Ctx, src: string, from: string) =>
  parseMarkdown(src).flatMap((b) => (b.t === "embed" ? [b.target ? resolveLink(b.target, from, sheets, wsOf(ctx)).path : from] : [])).filter((p): p is string => !!p);

/** A Markdown sheet's HTML with its embeds (docs/adr/0029): the targets read first, three levels deep. */
const expand = async (ctx: Ctx, src: string, path: string) => {
  let frontier = [{ src, path }];
  for (let depth = 0; depth < 4 && frontier.length; depth++) {
    const next: { src: string; path: string }[] = [];
    for (const f of frontier)
      for (const to of embedTargets(ctx, f.src, f.path)) {
        if (/\.(png|jpe?g|gif|webp|svg)$/i.test(to)) continue;
        const known = textOf(ctx, to) !== null;
        const text = await readText(ctx, to);
        if (!known && to.endsWith(".md")) next.push({ src: text, path: to });
      }
    frontier = next;
  }
  const html = expandEmbeds(src, path, { resolve: (t, from) => resolveLink(t, from, sheets, wsOf(ctx)).path, read: (p) => textOf(ctx, p), plain: plainHtml, breaks: ctx.config.markdownBreaks });
  // links to targets not found are drawn apart (docs/adr/0027)
  return markMissing(html, (t) => resolveLink(t, path, sheets, wsOf(ctx)).path !== null);
};

export const mountWikilinks = (ctx: Ctx) => {
  treeReloaded.push(rebuild);
  markdownHook.expand = (src, path) => expand(ctx, src, path);
  ctx.right.links = { icon: "link", title: "リンク", render: (el) => {
    drawPanel(el, ctx);
    el.onclick = async (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>("[data-lk-open],[data-lk-target]");
      const d = focused(ctx.store.get());
      if (!t || !d) return;
      if (t.dataset.lkOpen) {
        const line = Number(t.dataset.lkLine);
        await ctx.open([t.dataset.lkOpen], { line, col: 0 });
        ctx.editors.get(t.dataset.lkOpen)?.goto(line, 0);
      } else await follow(ctx, d.path, { target: t.dataset.lkTarget ?? "", heading: t.dataset.lkHeading || null });
    };
  } };

  // the editor of a Markdown sheet: marks, ⌘-click, completion
  ctx.editorPlugins.push((doc, c) => {
    if (doc.kind !== "md") return null;
    let te: TextEditor | null = null;
    const pathNow = () => [...c.editors.entries()].find(([, e]) => e.edit === te)?.[0] ?? doc.path;
    return {
      attach: (t) => {
        te = t;
        const path = pathNow();
        editors.set(path, t);
        let timer = 0;
        const changed = () => {
          clearTimeout(timer);
          timer = window.setTimeout(() => {
            const p = pathNow();
            texts.set(p, t.core.text());
            reindex(c);
          }, 500);
        };
        const off = t.core.listen(changed);
        // ⌘-click on a link opens its target
        const onDown = (e: MouseEvent) => {
          if (!e.metaKey || e.button !== 0) return;
          const pos = t.view.posAtCoords(e.clientX, e.clientY);
          if (pos === null) return;
          const l = parseWikilinks(t.core.text()).find((x) => x.from <= pos && pos <= x.to);
          if (!l) return;
          e.preventDefault();
          e.stopPropagation();
          void follow(c, pathNow(), l);
        };
        t.view.content.addEventListener("mousedown", onDown, true);
        queueMicrotask(() => mark(c, path, t));
        return () => {
          clearTimeout(timer);
          off();
          t.view.content.removeEventListener("mousedown", onDown, true);
          for (const [p, e] of editors) if (e === t) editors.delete(p);
        };
      },
      complete: async (pos) => {
        if (!te) return null;
        const text = te.core.text();
        const from = pathNow();
        // the target's text, for its headings: read once and asked again on the next keystroke
        const r = completeAt(text, pos, sheets, (p) => textOf(c, p) ?? (void readText(c, p), ""), from, wsOf(c));
        return r && r.items.length ? r : null;
      },
    };
  });

  // an embed's head opens its target
  document.addEventListener("click", (e) => {
    const h = (e.target as HTMLElement).closest<HTMLElement>("[data-embed-open]");
    if (!h) return;
    const path = h.dataset.embedOpen!;
    const heading = h.dataset.embedHeading ?? null;
    void (async () => {
      const line = heading ? findHeading(await readText(ctx, path), kindOf(path), heading) : null;
      await ctx.open([path], line ? { line, col: 0 } : undefined);
      if (line) ctx.editors.get(path)?.goto(line, 0);
    })();
  });

  // the preview's links
  document.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest<HTMLAnchorElement>("a.wikilink");
    const d = focused(ctx.store.get());
    if (!a || !d) return;
    e.preventDefault();
    void follow(ctx, d.path, { target: a.dataset.wikilink ?? "", heading: a.dataset.heading ?? null });
  });

  // a saved sheet: its links read again
  ctx.store.subscribe((s, prev) => {
    for (const d of allDocs(s)) {
      if (d.kind !== "md") continue;
      const before = allDocs(prev).find((x) => x.path === d.path);
      if (before && before.saved !== d.saved) {
        texts.set(d.path, d.saved);
        reindex(ctx);
      }
    }
    // a saved sheet may be embedded in the preview: draw it again (docs/adr/0029)
    for (const d of allDocs(s)) {
      const before = allDocs(prev).find((x) => x.path === d.path);
      if (!before || before.saved === d.saved) continue;
      others.delete(d.path);
      const f = focused(s);
      if (f?.kind === "md" && f.path !== d.path) {
        markdownHook.version++;
        ctx.refresh(["side"]);
      }
    }
    if (s.right === "links" && s.showRight && (s.focus !== prev.focus || s.open !== prev.open)) ctx.refresh(["right"]);
  });

  // a renamed file: the links that named it by path or by file name follow, after asking
  ctx.onRename.push(async (from, to, c) => {
    const ws = wsOf(c);
    if (!sheets.some((s) => s.path === from)) return;
    const plans = [...texts]
      .map(([path, text]) => {
        const at = path === from ? to : path;
        const live = c.editors.get(at)?.edit;
        const now = live ? live.core.text() : text;
        return { path: at, live, now, edits: renameEdits(now, path, from, to, sheets, ws) };
      })
      .filter((p) => p.edits.length);
    const n = plans.reduce((k, p) => k + p.edits.length, 0);
    if (!n || !(await confirmDialog(`${n} 件のリンクを書き換えますか`, "書き換える"))) return;
    for (const p of plans) {
      if (p.live) p.live.apply(p.edits, "rename-links");
      else await api.writeText(p.path, p.edits.reduceRight((s, e) => s.slice(0, e.from) + e.insert + s.slice(e.to), p.now));
    }
  });
};
