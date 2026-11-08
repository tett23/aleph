// The editor area's panes and tabs (docs/adr/0024): one or two panes side by
// side, each with a row of tabs. A tab's editors are kept, hidden, while
// another tab is shown, so the caret, the scroll and the undo history stay.
// The state's panes and tabs are in store.ts; this keeps the DOM in step.
import { addCommands } from "../commands.ts";
import type { Ctx } from "../ctx.ts";
import type { Editor } from "../ed/editor.ts";
import { esc } from "../esc.ts";
import { h, icon } from "../icons.ts";
import { rel, stem } from "../path.ts";
import { loadManifest } from "../separator.ts";
import { closeTarget, dirty, type Doc, type State, type Tab } from "../store.ts";
import { canVertical } from "../toolbar.ts";
import { uiState } from "../uistate.ts";
import { openPalette } from "../palette.ts";
import { api } from "../api.ts";
import { revealItems, tabTarget } from "../reveal.ts";
import { menu, toast } from "../ui/dom.ts";

const tabKey = (t: Tab) => String(t.id);

/** Whether a tab's sheets are written vertically: the switch is on and every sheet can be. */
const tabVertical = (s: State, t: Tab) => s.vertical && t.open.length > 0 && t.open.every((d) => canVertical(d.kind));

export const tabTitle = (ctx: Ctx, t: Tab) => {
  if (t.plot) return "プロット";
  const d = t.open[0];
  const name = d ? (ctx.titles.get(d.path) ?? stem(d.path)) : "";
  return t.open.length > 1 ? `${name} ほか ${t.open.length - 1} 章` : name;
};

/** A tab's DOM: its editors by sheet path (in the tab's order), kept while the tab lives. */
type View = { el: HTMLElement; host: HTMLElement | null; editors: Map<string, Editor>; vertical: boolean };

const SPLIT_KEY = "splitRatio";

/** Closes a tab after saving its sheets with changes. */
export const closeTab = async (ctx: Ctx, pane: number, index: number) => {
  const docs = closeTarget(ctx.store.get(), pane, index);
  if (docs.length) await ctx.save(docs.map((d) => d.path));
  ctx.store.dispatch({ type: "closeTab", pane, index });
};

export const mountPanes = (ctx: Ctx, editorFor: (el: HTMLElement, doc: Doc, index: number, scroller: HTMLElement | undefined) => Editor) => {
  ctx.view.main = (el) => {
    const root = h(`<div class="panes"></div>`);
    el.append(root);
    const views = new Map<string, View>();
    let paneEls: HTMLElement[] = [];

    const build = (s: State, t: Tab): View => {
      const view: View = { el: h(`<div class="tabview"></div>`), host: null, editors: new Map(), vertical: tabVertical(s, t) };
      if (t.plot) {
        const ed = ctx.kindViews.plot?.(view.el, { path: `${t.plot}/plot.csv`, project: t.plot } as Doc, ctx);
        if (ed) view.editors.set(`plot:${t.plot}`, ed);
        return view;
      }
      const many = t.open.length > 1;
      const host = h(`<div class="${many ? "multi" : "single"}${view.vertical ? " vertical" : ""}"></div>`);
      view.host = host;
      view.el.append(host);
      // the manifest decides the paragraph separator of the page break estimates
      for (const p of new Set(t.open.flatMap((d) => (d.project ? [d.project] : []))))
        void loadManifest(p).then(() => t.open.forEach((d) => d.project === p && ctx.editors.get(d.path)?.refreshMarks()));
      t.open.forEach((doc, i) => {
        const sec = many
          ? h(`<section class="msec"><div class="mhead">${esc(ctx.titles.get(doc.path) ?? stem(doc.path))}<small>${esc(doc.workspace ? rel(doc.workspace, doc.path) : doc.path)}</small></div><div class="mhost"></div></section>`)
          : h(`<div class="mhost single-host"></div>`);
        host.append(sec);
        const ed = editorFor(sec.querySelector<HTMLElement>(".mhost") ?? sec, doc, i, many ? host : undefined);
        view.editors.set(doc.path, ed);
        ctx.editors.set(doc.path, ed);
      });
      return view;
    };

    const destroy = (key: string) => {
      const v = views.get(key);
      if (!v) return;
      v.editors.forEach((ed, p) => {
        ed.destroy();
        if (ctx.editors.get(p) === ed) ctx.editors.delete(p);
      });
      v.el.remove();
      views.delete(key);
    };

    const tabBar = (s: State, pi: number) => {
      const p = s.panes[pi];
      const tabs = p.tabs
        .map((t, k) => {
          const mark = t.open.some(dirty) ? `<span class="dirty">●</span>` : "";
          const tip = t.open[0] ? (t.open[0].workspace ? rel(t.open[0].workspace, t.open[0].path) : t.open[0].path) : "";
          return `<div class="tab ${k === p.active ? "on" : ""}" data-tab="${k}" title="${esc(tip)}"><span class="tl">${esc(tabTitle(ctx, t))}</span>${mark}<span class="iconbtn tx" data-tab-x="${k}" title="閉じる（⌘W）">${icon("x", 11)}</span></div>`;
        })
        .join("");
      return `${tabs}<span class="iconbtn tadd" data-tab-add title="新しいタブ">${icon("plus", 13)}</span>`;
    };

    const welcome = (s: State) =>
      `<div class="welcome"><img src="/icon.svg" alt=""><div>${s.workspaces.length ? "左からシートを選んでください。" : "設定の「ワークスペース」で、Git のリポジトリなどのフォルダを足してください。"}</div></div>`;

    /** Lays out the panes (one, or two with a divider between). */
    const layout = (s: State) => {
      if (paneEls.length === s.panes.length) return;
      // the views are kept across a re-layout; only their panes change
      views.forEach((v) => v.el.remove());
      root.innerHTML = "";
      paneEls = s.panes.map((_, i) => h(`<div class="epane" data-pane="${i}"><div class="tabbar"></div><div class="ebody"></div></div>`));
      paneEls.forEach((p, i) => {
        if (i > 0) root.append(h(`<div class="ediv" title="ドラッグして幅を変える"></div>`));
        root.append(p);
      });
      if (paneEls.length === 2) paneEls[0].style.flex = `0 0 ${uiState().get(SPLIT_KEY, 0.5) * 100}%`;
    };

    const draw = (s: State, prev: State | null) => {
      layout(s);
      const live = new Set<string>();
      s.panes.forEach((p, pi) => {
        const pe = paneEls[pi];
        pe.classList.toggle("on", s.panes.length > 1 && pi === s.pane);
        pe.querySelector(".tabbar")!.innerHTML = tabBar(s, pi);
        const body = pe.querySelector<HTMLElement>(".ebody")!;
        body.querySelector(":scope > .welcome")?.remove();
        if (!p.tabs.length) body.insertAdjacentHTML("beforeend", welcome(s));
        p.tabs.forEach((t, k) => {
          const key = tabKey(t);
          live.add(key);
          let v = views.get(key);
          if (!v) {
            v = build(s, t);
            views.set(key, v);
          }
          if (v.el.parentElement !== body) body.append(v.el);
          // a renamed sheet keeps its editor under the new path
          if (!t.plot && [...v.editors.keys()].join("\n") !== t.open.map((d) => d.path).join("\n")) {
            const eds = [...v.editors.entries()];
            v.editors = new Map(t.open.map((d, i) => [d.path, eds[i][1]]));
            eds.forEach(([old, ed]) => ctx.editors.get(old) === ed && ctx.editors.delete(old));
            v.editors.forEach((ed, path) => ctx.editors.set(path, ed));
          }
          v.el.hidden = k !== p.active;
          // the vertical switch changes the writing mode of the editors in place
          const vert = tabVertical(s, t);
          if (vert !== v.vertical) {
            v.vertical = vert;
            v.host?.classList.toggle("vertical", vert);
            if (v.host) (v.host.scrollTop = 0), (v.host.scrollLeft = 0);
            v.editors.forEach((e) => e.setVertical(vert));
          }
        });
      });
      for (const key of [...views.keys()]) if (!live.has(key)) destroy(key);

      // the caret: where an opener asked, or in the sheet of a newly selected tab
      const at = ctx.pendingAt;
      ctx.pendingAt = null;
      const d = s.open[s.focus];
      const ed = d && ctx.editors.get(d.path);
      const activeId = (x: State) => x.panes[x.pane]?.tabs[x.panes[x.pane].active]?.id;
      const switched = !prev || activeId(prev) !== activeId(s);
      if (at) ed?.goto(at.line, at.col);
      else if (switched) ed?.focus();
    };

    // presses: select a pane, select or close a tab, drag a tab, drag the divider
    root.addEventListener(
      "mousedown",
      (e) => {
        const pe = (e.target as HTMLElement).closest<HTMLElement>(".epane");
        const pi = Number(pe?.dataset.pane);
        if (pe && pi !== ctx.store.get().pane) ctx.store.dispatch({ type: "selectPane", pane: pi });
      },
      true,
    );
    root.addEventListener("mousedown", (e) => {
      const t = e.target as HTMLElement;
      if (e.button !== 0) return;
      if (t.closest(".ediv")) return dragDivider(e);
      const tab = t.closest<HTMLElement>("[data-tab]");
      if (!tab || t.closest("[data-tab-x]")) return;
      dragTab(e, Number(tab.closest<HTMLElement>(".epane")!.dataset.pane), Number(tab.dataset.tab));
    });
    root.addEventListener("mouseup", (e) => {
      const t = e.target as HTMLElement;
      if (e.button !== 0) return;
      const x = t.closest<HTMLElement>("[data-tab-x]");
      const pane = Number(t.closest<HTMLElement>(".epane")?.dataset.pane);
      if (x) return void closeTab(ctx, pane, Number(x.dataset.tabX));
      if (t.closest("[data-tab-add]")) {
        const c = ctx.commands.find((c) => c.id === "file.newTab");
        if (c) void c.run(ctx);
      }
    });

    // a tab's right-click: "Finder で表示" for the sheet or plot it shows (docs/adr/0053)
    root.addEventListener("contextmenu", (e) => {
      const tab = (e.target as HTMLElement).closest<HTMLElement>("[data-tab]");
      const pane = Number(tab?.closest<HTMLElement>(".epane")?.dataset.pane);
      const t = tab ? ctx.store.get().panes[pane]?.tabs[Number(tab.dataset.tab)] : undefined;
      const path = t ? tabTarget(t) : null;
      if (!tab || !path) return;
      e.preventDefault();
      menu(tab, revealItems(path, (x) => void api.revealPath(x).catch((err) => toast(String(err))), icon("folder", 14)));
    });

    const dragTab = (down: MouseEvent, pane: number, index: number) => {
      down.preventDefault();
      let target: { pane: number; index: number } | null = null;
      const move = (e: MouseEvent) => {
        if (Math.abs(e.clientX - down.clientX) < 4 && !target) return;
        root.querySelectorAll(".tab.drop, .tabbar.drop").forEach((x) => x.classList.remove("drop", "after"));
        const bar = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>(".tabbar");
        if (!bar) return void (target = null);
        const toPane = Number(bar.closest<HTMLElement>(".epane")!.dataset.pane);
        const tabs = [...bar.querySelectorAll<HTMLElement>("[data-tab]")];
        let k = tabs.findIndex((x) => e.clientX < x.getBoundingClientRect().left + x.getBoundingClientRect().width / 2);
        if (k < 0) k = tabs.length;
        target = { pane: toPane, index: k };
        (tabs[k] ?? bar).classList.add("drop");
        if (!tabs[k]) bar.classList.add("after");
      };
      const up = () => {
        document.removeEventListener("mousemove", move, true);
        document.removeEventListener("mouseup", up, true);
        root.querySelectorAll(".tab.drop, .tabbar.drop").forEach((x) => x.classList.remove("drop", "after"));
        if (!target) return ctx.store.dispatch({ type: "selectTab", pane, index });
        // within a pane, dropping after itself keeps the place
        const to = target.pane === pane && target.index > index ? { ...target, index: target.index - 1 } : target;
        if (to.pane === pane && to.index === index) return ctx.store.dispatch({ type: "selectTab", pane, index });
        ctx.store.dispatch({ type: "moveTab", from: { pane, index }, to });
      };
      document.addEventListener("mousemove", move, true);
      document.addEventListener("mouseup", up, true);
    };

    const dragDivider = (down: MouseEvent) => {
      down.preventDefault();
      const box = root.getBoundingClientRect();
      let ratio = uiState().get(SPLIT_KEY, 0.5);
      const move = (e: MouseEvent) => {
        ratio = Math.min(0.85, Math.max(0.15, (e.clientX - box.left) / box.width));
        paneEls[0].style.flex = `0 0 ${ratio * 100}%`;
      };
      const up = () => {
        document.removeEventListener("mousemove", move, true);
        document.removeEventListener("mouseup", up, true);
        uiState().set(SPLIT_KEY, ratio);
      };
      document.addEventListener("mousemove", move, true);
      document.addEventListener("mouseup", up, true);
    };

    draw(ctx.store.get(), null);
    const off = ctx.store.subscribe((s, prev) => {
      if (s.panes !== prev.panes || s.pane !== prev.pane || s.vertical !== prev.vertical || s.workspaces !== prev.workspaces) draw(s, prev);
    });
    return () => {
      off();
      for (const key of [...views.keys()]) destroy(key);
      root.remove();
    };
  };

  const tabCount = (st: State) => st.panes[st.pane]?.tabs.length ?? 0;
  addCommands(ctx.commands, 
    { id: "file.newTab", label: "新しいタブでシートを開く", icon: "plus", when: (st) => !!st.workspace, run: (c) => openPalette(c, "", { alt: true }) },
    {
      id: "file.closeTab",
      label: "タブを閉じる",
      icon: "x",
      keys: ["Mod-w"],
      when: (st) => tabCount(st) > 0,
      run: (c) => {
        const st = c.store.get();
        return closeTab(c, st.pane, st.panes[st.pane].active);
      },
    },
    { id: "view.nextTab", label: "次のタブ", icon: "chevron-right", keys: ["Ctrl-Tab"], when: (st) => tabCount(st) > 1, run: (c) => c.store.dispatch({ type: "cycleTab", dir: 1 }) },
    { id: "view.prevTab", label: "前のタブ", icon: "chevron-right", keys: ["Ctrl-Shift-Tab"], when: (st) => tabCount(st) > 1, run: (c) => c.store.dispatch({ type: "cycleTab", dir: -1 }) },
    ...Array.from({ length: 9 }, (_, i) => ({
      id: `view.tab${i + 1}`,
      label: `${i + 1} 番目のタブ`,
      icon: "file",
      keys: [`Mod-${i + 1}`],
      when: (st: State) => tabCount(st) > i,
      run: (c: Ctx) => c.store.dispatch({ type: "selectTab", pane: c.store.get().pane, index: i }),
    })),
    {
      id: "view.split",
      label: "右に分ける",
      icon: "panel-right",
      menu: true,
      // a pane of one tab is not split; split already, the tab moves to the other pane
      when: (st) => (st.panes.length === 1 ? tabCount(st) > 1 : tabCount(st) > 0),
      run: (c) => c.store.dispatch({ type: "split" }),
    },
  );
};
