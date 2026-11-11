// The app's state as one value, changed only through the reducer (docs/adr/0003).
// No DOM and no Tauri here, so that node --test can run it.

export type Grid = { chars: number; lines: number; vertical: boolean };

/** A sheet opened in the editor. `text` is the editor's text, `saved` what is on disk. */
export type Doc = {
  path: string;
  kind: string;
  text: string;
  saved: string;
  project: string | null;
  workspace: string | null;
  grid: Grid;
};

export type LeftPanel = "files" | "bookmarks" | "keywords" | "search" | "git" | "diagnostics" | "library" | "trash";
export type RightPanel = "attach" | "outline" | "links" | "library";
export type SidePane = "none" | "plain" | "pages";

/** A tab: one sheet, chapters opened together (and the one the right panel follows), or a project's plot (docs/adr/0024). */
export type Tab = { id: number; open: Doc[]; focus: number; plot: string | null };
/** A pane of the editor area: its tabs and the selected one. */
export type Pane = { tabs: Tab[]; active: number };

export type State = {
  workspaces: string[];
  workspace: string | null;
  left: LeftPanel;
  showLeft: boolean;
  right: RightPanel;
  showRight: boolean;
  side: SidePane;
  vertical: boolean;
  /** The editor area's panes (one, or two side by side), and the selected one. */
  panes: Pane[];
  pane: number;
  /** The next tab's id (a tab keeps its id while its sheets are edited or renamed). */
  seq: number;
  /** The selected tab's sheets, in order (a copy kept by the reducer). One sheet is an array of one. */
  open: Doc[];
  /** The index in `open` of the sheet the right panel and the status bar follow. */
  focus: number;
  /** The rows selected in the tree, and where a shift-click range starts. */
  selected: string[];
  anchor: string | null;
  expanded: string[];
  /** The selected tab's plot (a copy kept by the reducer). */
  plot: string | null;
};

export type Action =
  | { type: "workspaces"; workspaces: string[] }
  | { type: "workspace"; path: string | null }
  | { type: "open"; docs: Doc[]; newTab?: boolean }
  | { type: "close" }
  | { type: "closeTab"; pane: number; index: number }
  | { type: "selectTab"; pane: number; index: number }
  | { type: "selectPane"; pane: number }
  | { type: "cycleTab"; dir: 1 | -1 }
  | { type: "moveTab"; from: { pane: number; index: number }; to: { pane: number; index: number } }
  | { type: "split" }
  | { type: "focusDoc"; path: string }
  | { type: "restoreTabs"; panes: { tabs: Omit<Tab, "id">[]; active: number }[]; pane: number }
  | { type: "focus"; index: number }
  | { type: "edit"; path: string; text: string }
  | { type: "saved"; path: string; text: string; pageSave?: "explicit" | "intermediate"; beforeFormat?: string }
  | { type: "rename"; from: string; to: string }
  | { type: "select"; paths: string[]; anchor?: string | null }
  | { type: "left"; panel: LeftPanel }
  | { type: "right"; panel: RightPanel }
  | { type: "toggleRight" }
  | { type: "side"; side: SidePane }
  | { type: "vertical"; on: boolean }
  | { type: "expand"; path: string; on: boolean }
  | { type: "collapseAll" }
  | { type: "plot"; project: string | null; newTab?: boolean };

export const initialState = (): State => ({
  workspaces: [],
  workspace: null,
  left: "files",
  showLeft: true,
  right: "attach",
  showRight: true,
  side: "none",
  vertical: false,
  panes: [{ tabs: [], active: 0 }],
  pane: 0,
  seq: 1,
  open: [],
  focus: 0,
  selected: [],
  anchor: null,
  expanded: [],
  plot: null,
});

const activeTab = (s: State): Tab | null => {
  const p = s.panes[s.pane];
  return p?.tabs[p.active] ?? null;
};

/** The state with `open`, `focus` and `plot` copied from the selected tab. */
const settle = (s: State): State => {
  const t = activeTab(s);
  return { ...s, open: t?.open ?? [], focus: t?.focus ?? 0, plot: t?.plot ?? null };
};

const withPanes = (s: State, panes: Pane[], pane = s.pane): State => settle({ ...s, panes, pane: Math.max(0, Math.min(pane, panes.length - 1)) });

const setPane = (panes: Pane[], i: number, p: Pane) => panes.map((x, k) => (k === i ? p : x));

type Content = Omit<Tab, "id">;

/** The selected tab replaced by a new one (or made, in an empty pane). */
const replaceActive = (s0: State, c: Content): State => {
  const s = { ...s0, seq: s0.seq + 1 };
  const t: Tab = { ...c, id: s0.seq };
  const p = s.panes[s.pane];
  const tabs = p.tabs.length ? p.tabs.map((x, k) => (k === p.active ? t : x)) : [t];
  return withPanes(s, setPane(s.panes, s.pane, { tabs, active: p.tabs.length ? p.active : 0 }));
};

const addTab = (s0: State, c: Content): State => {
  const s = { ...s0, seq: s0.seq + 1 };
  const t: Tab = { ...c, id: s0.seq };
  const p = s.panes[s.pane];
  const at = p.tabs.length ? p.active + 1 : 0;
  return withPanes(s, setPane(s.panes, s.pane, { tabs: [...p.tabs.slice(0, at), t, ...p.tabs.slice(at)], active: at }));
};

/** Where a sheet is open: its pane, tab, and index in the tab. */
const findDoc = (s: State, path: string) => {
  for (let pi = 0; pi < s.panes.length; pi++)
    for (let ti = 0; ti < s.panes[pi].tabs.length; ti++) {
      const di = s.panes[pi].tabs[ti].open.findIndex((d) => d.path === path);
      if (di >= 0) return { pane: pi, tab: ti, doc: di };
    }
  return null;
};

const select = (s: State, pane: number, tab: number, focus?: number): State => {
  const panes = s.panes.map((p, k) =>
    k === pane ? { ...p, active: tab, tabs: focus === undefined ? p.tabs : p.tabs.map((t, j) => (j === tab ? { ...t, focus } : t)) } : p,
  );
  return withPanes(s, panes, pane);
};

/** Removes a tab; an emptied pane beside another goes away (the split ends). */
const removeTab = (s: State, pane: number, index: number): State => {
  const p = s.panes[pane];
  if (!p || index < 0 || index >= p.tabs.length) return s;
  const tabs = p.tabs.filter((_, k) => k !== index);
  const active = index < p.active ? p.active - 1 : index === p.active ? Math.min(index, tabs.length - 1) : p.active;
  if (!tabs.length && s.panes.length > 1) {
    const panes = s.panes.filter((_, k) => k !== pane);
    return withPanes(s, panes, s.pane > pane ? s.pane - 1 : s.pane === pane ? 0 : s.pane);
  }
  return withPanes(s, setPane(s.panes, pane, { tabs, active: Math.max(0, active) }));
};

const mapTabs = (s: State, f: (d: Doc) => Doc): State =>
  settle({ ...s, panes: s.panes.map((p) => ({ ...p, tabs: p.tabs.map((t) => ({ ...t, open: t.open.map(f) })) })) });

const moved = (path: string, from: string, to: string) => (path === from ? to : path.startsWith(from + "/") ? to + path.slice(from.length) : path);

const ancestors = (path: string, root: string): string[] => {
  const out: string[] = [];
  let d = path.slice(0, path.lastIndexOf("/"));
  while (d.length > root.length && d.startsWith(root + "/")) {
    out.push(d);
    d = d.slice(0, d.lastIndexOf("/"));
  }
  return out;
};

export const reduce = (s: State, a: Action): State => {
  switch (a.type) {
    case "workspaces": {
      const workspace = s.workspace && a.workspaces.includes(s.workspace) ? s.workspace : (a.workspaces[0] ?? null);
      return { ...s, workspaces: a.workspaces, workspace };
    }
    case "workspace":
      return settle({ ...s, workspace: a.path, panes: [{ tabs: [], active: 0 }], pane: 0, selected: [], anchor: null });
    case "open": {
      // opening shows the files down to each sheet in the tree
      const expanded = new Set(s.expanded);
      for (const d of a.docs) if (d.workspace) ancestors(d.path, d.workspace).forEach((p) => expanded.add(p));
      const tree = {
        expanded: [...expanded],
        selected: a.docs.length > 1 ? a.docs.map((d) => d.path) : [],
        anchor: a.docs.length === 1 ? a.docs[0].path : s.anchor,
      };
      // a sheet opens once: one already open (alone or among chapters) is selected where it is
      if (a.docs.length === 1) {
        const at = findDoc(s, a.docs[0].path);
        if (at) return { ...select(s, at.pane, at.tab, at.doc), ...tree };
      } else {
        const same = s.panes.flatMap((p, pi) => p.tabs.flatMap((t, ti) => (t.open.map((d) => d.path).join("\n") === a.docs.map((d) => d.path).join("\n") ? [{ pi, ti }] : [])))[0];
        if (same) return { ...select(s, same.pi, same.ti, 0), ...tree };
      }
      // chapters opened together leave the tabs they were in on their own
      let base = s;
      if (a.docs.length > 1)
        for (const d of a.docs) {
          const at = findDoc(base, d.path);
          if (!at) continue;
          const t = base.panes[at.pane].tabs[at.tab];
          const rest = t.open.filter((x) => x.path !== d.path);
          base = rest.length
            ? withPanes(base, setPane(base.panes, at.pane, { ...base.panes[at.pane], tabs: base.panes[at.pane].tabs.map((x, k) => (k === at.tab ? { ...x, open: rest, focus: 0 } : x)) }))
            : removeTab(base, at.pane, at.tab);
        }
      const tab: Content = { open: a.docs, focus: 0, plot: null };
      return { ...(a.newTab ? addTab(base, tab) : replaceActive(base, tab)), ...tree };
    }
    case "close":
      return { ...removeTab(s, s.pane, s.panes[s.pane]?.active ?? 0), selected: [] };
    case "closeTab":
      return removeTab(s, a.pane, a.index);
    case "selectTab":
      return s.panes[a.pane] && a.index >= 0 && a.index < s.panes[a.pane].tabs.length ? select(s, a.pane, a.index) : s;
    case "selectPane":
      return a.pane >= 0 && a.pane < s.panes.length && a.pane !== s.pane ? withPanes(s, s.panes, a.pane) : s;
    case "cycleTab": {
      const p = s.panes[s.pane];
      if (p.tabs.length < 2) return s;
      return select(s, s.pane, (p.active + a.dir + p.tabs.length) % p.tabs.length);
    }
    case "moveTab": {
      const src = s.panes[a.from.pane];
      const t = src?.tabs[a.from.index];
      if (!t || !s.panes[a.to.pane]) return s;
      let panes = setPane(s.panes, a.from.pane, { tabs: src.tabs.filter((_, k) => k !== a.from.index), active: 0 });
      const dst = panes[a.to.pane];
      const at = Math.max(0, Math.min(a.to.index, dst.tabs.length));
      panes = setPane(panes, a.to.pane, { tabs: [...dst.tabs.slice(0, at), t, ...dst.tabs.slice(at)], active: at });
      // the source pane keeps its selection on the same tab where it can
      if (a.from.pane !== a.to.pane) {
        const left = panes[a.from.pane];
        const keep = src.active > a.from.index ? src.active - 1 : Math.min(src.active, left.tabs.length - 1);
        panes = setPane(panes, a.from.pane, { ...left, active: Math.max(0, keep) });
        if (!left.tabs.length && panes.length > 1) return withPanes(s, panes.filter((_, k) => k !== a.from.pane), a.to.pane > a.from.pane ? a.to.pane - 1 : a.to.pane);
      }
      return withPanes(s, panes, a.to.pane);
    }
    case "split": {
      const p = s.panes[s.pane];
      const t = activeTab(s);
      if (!t) return s;
      if (s.panes.length === 1) {
        if (p.tabs.length < 2) return s;
        const left = { tabs: p.tabs.filter((_, k) => k !== p.active), active: Math.min(p.active, p.tabs.length - 2) };
        return withPanes(s, [left, { tabs: [t], active: 0 }], 1);
      }
      const other = 1 - s.pane;
      return reduce(s, { type: "moveTab", from: { pane: s.pane, index: p.active }, to: { pane: other, index: s.panes[other].tabs.length } });
    }
    case "focusDoc": {
      const at = findDoc(s, a.path);
      if (!at) return s;
      const p = s.panes[at.pane];
      return at.pane === s.pane && at.tab === p.active && p.tabs[at.tab].focus === at.doc ? s : select(s, at.pane, at.tab, at.doc);
    }
    case "restoreTabs": {
      if (!a.panes.length) return s;
      let seq = s.seq;
      const panes = a.panes.map((p) => ({ active: Math.max(0, Math.min(p.active, p.tabs.length - 1)), tabs: p.tabs.map((t) => ({ ...t, id: seq++ })) }));
      return withPanes({ ...s, seq }, panes, a.pane);
    }
    case "focus":
      return a.index >= 0 && a.index < s.open.length ? select(s, s.pane, s.panes[s.pane].active, a.index) : s;
    case "edit":
      return mapTabs(s, (d) => (d.path === a.path ? { ...d, text: a.text } : d));
    case "saved":
      return mapTabs(s, (d) => (d.path === a.path ? { ...d, saved: a.text } : d));
    case "rename": {
      const panes = s.panes.map((p) => ({ ...p, tabs: p.tabs.map((t) => ({
        ...t,
        open: t.open.map((d) => ({ ...d, path: moved(d.path, a.from, a.to), project: d.project && moved(d.project, a.from, a.to) })),
        plot: t.plot && moved(t.plot, a.from, a.to),
      })) }));
      return {
        ...withPanes(s, panes),
        selected: s.selected.map((p) => moved(p, a.from, a.to)),
        anchor: s.anchor && moved(s.anchor, a.from, a.to),
        expanded: s.expanded.map((p) => moved(p, a.from, a.to)),
      };
    }
    case "select":
      return { ...s, selected: a.paths, anchor: a.anchor === undefined ? s.anchor : a.anchor };
    case "left":
      // the same icon again folds the sidebar
      return s.left === a.panel && s.showLeft ? { ...s, showLeft: false } : { ...s, left: a.panel, showLeft: true };
    case "right":
      return { ...s, right: a.panel, showRight: true };
    case "toggleRight":
      return { ...s, showRight: !s.showRight };
    case "side":
      return { ...s, side: a.side };
    case "vertical":
      return { ...s, vertical: a.on };
    case "expand": {
      const has = s.expanded.includes(a.path);
      if (has === a.on) return s;
      return { ...s, expanded: a.on ? [...s.expanded, a.path] : s.expanded.filter((p) => p !== a.path) };
    }
    case "collapseAll":
      return { ...s, expanded: [] };
    case "plot": {
      if (!a.project) return s.plot ? replaceActive(s, { open: [], focus: 0, plot: null }) : s;
      const at = s.panes.flatMap((p, pi) => p.tabs.flatMap((t, ti) => (t.plot === a.project ? [{ pi, ti }] : [])))[0];
      if (at) return { ...select(s, at.pi, at.ti), selected: [] };
      const tab: Content = { open: [], focus: 0, plot: a.project };
      return { ...(a.newTab ? addTab(s, tab) : replaceActive(s, tab)), selected: [] };
    }
  }
};

/** The sheets of every tab of every pane. */
export const allDocs = (s: State): Doc[] => s.panes.flatMap((p) => p.tabs.flatMap((t) => t.open));

/** The sheets with changes to save before a tab closes. */
export const closeTarget = (s: State, pane: number, index: number): Doc[] => (s.panes[pane]?.tabs[index]?.open ?? []).filter((d) => d.text !== d.saved);

/** The tabs as kept in config.json's ui: sheet paths or a plot's project (docs/adr/0024). */
export type TabUi = { paths: string[]; focus: number } | { plot: string };
export type TabsUi = { pane: number; panes: { active: number; tabs: TabUi[] }[] };

export const writeTabs = (s: State): TabsUi => ({
  pane: s.pane,
  panes: s.panes.map((p) => ({ active: p.active, tabs: p.tabs.map((t) => (t.plot ? { plot: t.plot } : { paths: t.open.map((d) => d.path), focus: t.focus })) })),
});

const isStrs = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

export const readTabs = (v: unknown): TabsUi | null => {
  const r = v as TabsUi | null | undefined;
  if (!r || typeof r !== "object" || !Array.isArray(r.panes) || typeof r.pane !== "number") return null;
  const panes = r.panes.flatMap((p) => {
    if (!p || typeof p !== "object" || !Array.isArray(p.tabs)) return [];
    const tabs = p.tabs.flatMap((t): TabUi[] =>
      t && typeof t === "object" && "plot" in t && typeof t.plot === "string"
        ? [{ plot: t.plot }]
        : t && typeof t === "object" && "paths" in t && isStrs(t.paths) && t.paths.length
          ? [{ paths: t.paths, focus: typeof t.focus === "number" ? t.focus : 0 }]
          : [],
    );
    return [{ active: typeof p.active === "number" ? p.active : 0, tabs }];
  });
  return panes.length ? { pane: r.pane, panes } : null;
};

/** The tabs with the sheets that no longer exist dropped, and the selections kept in range. */
export const dropMissing = (t: TabsUi, exists: (path: string) => boolean): TabsUi => {
  const panes = t.panes
    .map((p) => {
      const kept = p.tabs.flatMap((x, k): { x: TabUi; k: number }[] => {
        if ("plot" in x) return [{ x, k }];
        const paths = x.paths.filter(exists);
        return paths.length ? [{ x: { paths, focus: Math.min(x.focus, paths.length - 1) }, k }] : [];
      });
      // the selected tab, or the one that took its place (its right neighbour, as when a tab closes)
      const before = kept.filter((y) => y.k < p.active).length;
      return { active: Math.max(0, Math.min(before, kept.length - 1)), tabs: kept.map((y) => y.x) };
    })
    .filter((p, k, all) => p.tabs.length || all.length === 1);
  return { pane: Math.max(0, Math.min(t.pane, panes.length - 1)), panes: panes.length ? panes : [{ active: 0, tabs: [] }] };
};

/** The sheet the right panel and the status bar follow. */
export const focused = (s: State): Doc | null => s.open[s.focus] ?? null;

export const dirty = (d: Doc) => d.text !== d.saved;

export type Store = {
  get: () => State;
  dispatch: (a: Action) => void;
  subscribe: (f: (s: State, prev: State, action: Action) => void) => () => void;
};

export const createStore = (init: State = initialState()): Store => {
  let state = init;
  const subs = new Set<(s: State, prev: State, action: Action) => void>();
  return {
    get: () => state,
    dispatch: (a) => {
      const prev = state;
      state = reduce(state, a);
      if (state !== prev) subs.forEach((f) => f(state, prev, a));
    },
    subscribe: (f) => (subs.add(f), () => subs.delete(f)),
  };
};
