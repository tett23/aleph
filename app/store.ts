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

export type LeftPanel = "files" | "search" | "git" | "diagnostics" | "library";
export type RightPanel = "attach" | "outline" | "library";
export type SidePane = "none" | "plain" | "pages";

export type State = {
  workspaces: string[];
  workspace: string | null;
  left: LeftPanel;
  showLeft: boolean;
  right: RightPanel;
  showRight: boolean;
  side: SidePane;
  vertical: boolean;
  /** The sheets shown in the editor pane, in order. One sheet is an array of one. */
  open: Doc[];
  /** The index in `open` of the sheet the right panel and the status bar follow. */
  focus: number;
  /** The rows selected in the tree, and where a shift-click range starts. */
  selected: string[];
  anchor: string | null;
  expanded: string[];
  /** The project whose plot is shown instead of sheets. */
  plot: string | null;
};

export type Action =
  | { type: "workspaces"; workspaces: string[] }
  | { type: "workspace"; path: string | null }
  | { type: "open"; docs: Doc[] }
  | { type: "close" }
  | { type: "focus"; index: number }
  | { type: "edit"; path: string; text: string }
  | { type: "saved"; path: string; text: string }
  | { type: "rename"; from: string; to: string }
  | { type: "select"; paths: string[]; anchor?: string | null }
  | { type: "left"; panel: LeftPanel }
  | { type: "right"; panel: RightPanel }
  | { type: "toggleRight" }
  | { type: "side"; side: SidePane }
  | { type: "vertical"; on: boolean }
  | { type: "expand"; path: string; on: boolean }
  | { type: "collapseAll" }
  | { type: "plot"; project: string | null };

export const initialState = (): State => ({
  workspaces: [],
  workspace: null,
  left: "files",
  showLeft: true,
  right: "attach",
  showRight: true,
  side: "none",
  vertical: false,
  open: [],
  focus: 0,
  selected: [],
  anchor: null,
  expanded: [],
  plot: null,
});

const mapDoc = (s: State, path: string, f: (d: Doc) => Doc): Doc[] => s.open.map((d) => (d.path === path ? f(d) : d));

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
      return { ...s, workspace: a.path, open: [], focus: 0, selected: [], anchor: null, plot: null };
    case "open": {
      // opening shows the files down to each sheet in the tree
      const expanded = new Set(s.expanded);
      for (const d of a.docs) if (d.workspace) ancestors(d.path, d.workspace).forEach((p) => expanded.add(p));
      return {
        ...s,
        open: a.docs,
        focus: 0,
        plot: null,
        expanded: [...expanded],
        selected: a.docs.length > 1 ? a.docs.map((d) => d.path) : [],
        anchor: a.docs.length === 1 ? a.docs[0].path : s.anchor,
      };
    }
    case "close":
      return { ...s, open: [], focus: 0, selected: [] };
    case "focus":
      return a.index >= 0 && a.index < s.open.length ? { ...s, focus: a.index } : s;
    case "edit":
      return { ...s, open: mapDoc(s, a.path, (d) => ({ ...d, text: a.text })) };
    case "saved":
      return { ...s, open: mapDoc(s, a.path, (d) => ({ ...d, saved: a.text })) };
    case "rename":
      return {
        ...s,
        open: mapDoc(s, a.from, (d) => ({ ...d, path: a.to })),
        selected: s.selected.map((p) => (p === a.from ? a.to : p)),
        anchor: s.anchor === a.from ? a.to : s.anchor,
      };
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
    case "plot":
      return { ...s, plot: a.project, open: a.project ? [] : s.open, focus: 0, selected: a.project ? [] : s.selected };
  }
};

/** The sheet the right panel and the status bar follow. */
export const focused = (s: State): Doc | null => s.open[s.focus] ?? null;

export const dirty = (d: Doc) => d.text !== d.saved;

export type Store = {
  get: () => State;
  dispatch: (a: Action) => void;
  subscribe: (f: (s: State, prev: State) => void) => () => void;
};

export const createStore = (init: State = initialState()): Store => {
  let state = init;
  const subs = new Set<(s: State, prev: State) => void>();
  return {
    get: () => state,
    dispatch: (a) => {
      const prev = state;
      state = reduce(state, a);
      if (state !== prev) subs.forEach((f) => f(state, prev));
    },
    subscribe: (f) => (subs.add(f), () => subs.delete(f)),
  };
};
