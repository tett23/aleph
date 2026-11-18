// The preview tab (docs/adr/0087): the tab that shows the followed tab's sheet,
// the followed tab, what the tab shows, and when the pages are built again after a save.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dropMissing,
  focused,
  initialState,
  pagesAvailable,
  previewAvailable,
  readPreviewMode,
  readTabs,
  reduce,
  shown,
  writeTabs,
  type Action,
  type Doc,
  type State,
  type TabsUi,
} from "./store.ts";
import { readUi } from "./legacy-names.ts";
import { verticalOn } from "./toolbar.ts";
import { NO_PREVIEW, PICK_SHEET, previewMessage, previewShows, rebuildPagesOnSave } from "./preview/tab.ts";

const doc = (path: string): Doc => ({
  path,
  kind: path.split(".").pop()!,
  text: "",
  saved: "",
  project: "/w/p",
  workspace: "/w",
  grid: { chars: 38, lines: 16, vertical: false },
});

const run = (actions: Action[], from: State = initialState()) => actions.reduce(reduce, from);
const name = (s: State, id: number | null) => {
  if (id === null) return null;
  const t = s.panes.flatMap((p) => p.tabs).find((x) => x.id === id);
  return t ? t.open.map((d) => d.path).join("+") : `missing:${id}`;
};
const paths = (s: State) => s.panes.map((p) => p.tabs.map((t) => (t.preview ? "preview" : t.plot ? `plot:${t.plot}` : t.open.map((d) => d.path).join("+"))));
const previews = (s: State) => s.panes.flatMap((p) => p.tabs).filter((t) => t.preview).length;
const sheetTabs = (s: State) => s.panes.flatMap((p) => p.tabs).filter((t) => !t.preview && !t.plot && t.open.length > 0);
const activeTab = (s: State) => s.panes[s.pane].tabs[s.panes[s.pane].active];

/** I1, I2 and I4, checked on every state a test reaches. */
const invariants = (s: State) => {
  assert.ok(previews(s) <= 1, "I1: at most one preview tab");
  const sheets = sheetTabs(s);
  if (s.followed !== null) assert.ok(sheets.some((t) => t.id === s.followed), "I2: followed is a sheet tab");
  const sel = activeTab(s);
  if (sel && sheets.includes(sel)) assert.equal(s.followed, sel.id, "I2: the selected sheet tab is followed");
  if (sheets.length) assert.notEqual(s.followed, null, "I2: followed is set while a sheet tab exists");
  if (s.panes.length === 2) assert.ok(s.panes.every((p) => p.tabs.length > 0), "I4: both panes have tabs");
  return s;
};
const check = (actions: Action[], from: State = initialState()) => invariants(run(actions, from));

const A = "/w/a.md", B = "/w/b.md", C = "/w/c.md";
const ch1 = "/w/p/01.gm", ch2 = "/w/p/02.gm", ch3 = "/w/p/03.gm";
const sheet = (path: string) => ({ open: [doc(path)], focus: 0, plot: null });
const plotTab = (project: string) => ({ open: [], focus: 0, plot: project });
const previewTab = { open: [], focus: 0, plot: null, preview: true };
const restore = (panes: Extract<Action, { type: "restoreTabs" }>["panes"], pane: number): Action => ({ type: "restoreTabs", panes, pane });

// ---- showing the preview tab (I1, I3, I4)

test("ADR 0087 I3: one pane and no tab: preview.plain is not available and changes nothing", () => {
  const s = initialState();
  assert.equal(previewAvailable(s), false);
  assert.equal(run([{ type: "showPreview", mode: "plain" }], s), s);
});

test("ADR 0087 I1, I3, I4: one pane and one tab: preview.plain makes a right pane with the preview tab selected there; the left pane stays selected", () => {
  const before = check([{ type: "open", docs: [doc(A)] }]);
  assert.equal(previewAvailable(before), true);
  const s = check([{ type: "showPreview", mode: "plain" }], before);
  assert.deepEqual(paths(s), [[A], ["preview"]]);
  assert.equal(s.pane, 0);
  assert.equal(s.panes[1].active, 0);
  assert.equal(s.previewMode, "plain");
});

test("ADR 0087 I1, I3: two panes, a .gm selected on the left: preview.pages opens the preview tab at the end of the right pane, selected there", () => {
  const before = check([restore([{ tabs: [sheet(ch1)], active: 0 }, { tabs: [sheet(A), sheet(B)], active: 0 }], 0)]);
  assert.equal(pagesAvailable(before), true);
  const s = check([{ type: "showPreview", mode: "pages" }], before);
  assert.deepEqual(paths(s), [[ch1], [A, B, "preview"]]);
  assert.equal(s.panes[1].active, 2);
  assert.equal(s.pane, 0);
  assert.equal(s.previewMode, "pages");
});

test("ADR 0087 I3: with a .md selected, preview.pages is not available", () => {
  const s = check([{ type: "open", docs: [doc(A)] }]);
  assert.equal(pagesAvailable(s), false);
  assert.equal(pagesAvailable(initialState()), false);
});

test("ADR 0087 I3: the preview tab behind another tab of the selected pane: the button selects it, in the same pane, and keeps the mode", () => {
  const before = check([restore([{ tabs: [sheet(A), previewTab, sheet(B)], active: 2 }], 0), { type: "previewMode", mode: "pages" }]);
  const s = check([{ type: "showPreview" }], before);
  assert.equal(s.pane, 0);
  assert.equal(s.panes[0].active, 1);
  assert.equal(s.previewMode, "pages");
  assert.equal(previews(s), 1);
});

test("ADR 0087 I1, I3: preview.plain again does not add a tab", () => {
  const once = check([{ type: "open", docs: [doc(A)] }, { type: "showPreview", mode: "plain" }]);
  const twice = check([{ type: "showPreview", mode: "plain" }, { type: "selectPane", pane: 1 }, { type: "selectTab", pane: 1, index: 0 }, { type: "showPreview", mode: "pages" }], once);
  assert.equal(previews(twice), 1);
  assert.deepEqual(paths(twice), [[A], ["preview"]]);
});

// ---- the followed tab (I2, I5)

test("ADR 0087 I2: selecting chapter 1, then chapter 2: chapter 2's tab is followed", () => {
  const s = check([{ type: "open", docs: [doc(ch1)] }, { type: "open", docs: [doc(ch2)], newTab: true }, { type: "selectTab", pane: 0, index: 0 }, { type: "selectTab", pane: 0, index: 1 }]);
  assert.equal(name(s, s.followed), ch2);
});

test("ADR 0087 I2, I5: selecting the preview tab after chapter 2: chapter 2 stays followed, shown(s) is chapter 2 and focused(s) is null", () => {
  const s = check([
    { type: "open", docs: [doc(ch1)] },
    { type: "open", docs: [doc(ch2)], newTab: true },
    { type: "showPreview", mode: "plain" },
    { type: "selectPane", pane: 1 },
  ]);
  assert.equal(activeTab(s).preview, true);
  assert.equal(name(s, s.followed), ch2);
  assert.deepEqual(shown(s).open.map((d) => d.path), [ch2]);
  assert.equal(shown(s).focus, 0);
  assert.equal(focused(s), null);
});

test("ADR 0087 I2: selecting a plot tab opened before leaves the followed tab", () => {
  const s0 = check([{ type: "open", docs: [doc(ch1)] }, { type: "plot", project: "/w/p", newTab: true }, { type: "selectTab", pane: 0, index: 0 }]);
  const id = s0.followed;
  const s = check([{ type: "selectTab", pane: 0, index: 1 }], s0);
  assert.equal(s.followed, id);
  assert.equal(name(s, s.followed), ch1);
  assert.deepEqual(shown(s).open.map((d) => d.path), [ch1]);
});

test("ADR 0087 I2: [chapter 1] selected in one pane, view.plot: the tab becomes the plot and nothing is followed", () => {
  const s = check([{ type: "open", docs: [doc(ch1)] }, { type: "plot", project: "/w/p" }]);
  assert.deepEqual(paths(s), [["plot:/w/p"]]);
  assert.equal(s.followed, null);
  assert.deepEqual(shown(s).open, []);
});

test("ADR 0087 I2: [chapter 1, preview, chapter 2], chapter 1 closed and the preview selected: chapter 2 is followed", () => {
  const s0 = check([restore([{ tabs: [sheet(ch1), previewTab, sheet(ch2)], active: 0 }], 0)]);
  const s = check([{ type: "closeTab", pane: 0, index: 0 }], s0);
  assert.deepEqual(paths(s), [["preview", ch2]]);
  assert.equal(activeTab(s).preview, true);
  assert.equal(name(s, s.followed), ch2);
});

test("ADR 0087 I2: [chapter 1, chapter 2, preview, chapter 3], chapter 2 closed: of chapter 1 and 3 at the same distance, chapter 3 is followed", () => {
  const s0 = check([restore([{ tabs: [sheet(ch1), sheet(ch2), previewTab, sheet(ch3)], active: 1 }], 0)]);
  const s = check([{ type: "closeTab", pane: 0, index: 1 }], s0);
  assert.deepEqual(paths(s), [[ch1, "preview", ch3]]);
  assert.equal(activeTab(s).preview, true);
  assert.equal(name(s, s.followed), ch3);
});

test("ADR 0087 I2: left [chapter 1, plot (selected)], right [chapter 3 (followed), preview], chapter 3 closed: chapter 1 is followed", () => {
  const s0 = check([restore([{ tabs: [sheet(ch1), plotTab("/w/p")], active: 1 }, { tabs: [sheet(ch3), previewTab], active: 0 }], 1), { type: "selectPane", pane: 0 }]);
  assert.equal(name(s0, s0.followed), ch3);
  const s = check([{ type: "closeTab", pane: 1, index: 0 }], s0);
  assert.deepEqual(paths(s), [[ch1, "plot:/w/p"], ["preview"]]);
  assert.equal(name(s, s.followed), ch1);
});

test("ADR 0087 I2: every sheet tab closed, the preview tab alone: nothing is followed", () => {
  const s = check([{ type: "open", docs: [doc(A)] }, { type: "showPreview", mode: "plain" }, { type: "closeTab", pane: 0, index: 0 }]);
  assert.deepEqual(paths(s), [["preview"]]);
  assert.equal(s.followed, null);
  assert.deepEqual(shown(s).open, []);
});

test("ADR 0087 I2: the followed tab dragged to the other pane while selected stays followed", () => {
  const s0 = check([{ type: "open", docs: [doc(A)] }, { type: "open", docs: [doc(B)], newTab: true }, { type: "showPreview", mode: "plain" }]);
  const id = s0.followed;
  const s = check([{ type: "moveTab", from: { pane: 0, index: 1 }, to: { pane: 1, index: 1 } }], s0);
  assert.deepEqual(paths(s), [[A], ["preview", B]]);
  assert.equal(s.followed, id);
});

test("ADR 0087 I2: a workspace switch follows nothing", () => {
  const s = check([{ type: "open", docs: [doc(A)] }, { type: "showPreview", mode: "plain" }, { type: "workspace", path: "/v" }]);
  assert.equal(s.followed, null);
});

test("ADR 0087 I5: the text stays vertical when the preview tab is selected after a vertical sheet", () => {
  const s = check([{ type: "vertical", on: true }, { type: "open", docs: [doc(ch1)] }, { type: "showPreview", mode: "plain" }, { type: "selectPane", pane: 1 }]);
  assert.equal(focused(s), null);
  assert.equal(verticalOn({ vertical: s.vertical, open: shown(s).open }), true);
});

// ---- opening while the preview tab is selected (I6)

const withPreviewSelected = () => check([{ type: "open", docs: [doc(A)] }, { type: "showPreview", mode: "plain" }, { type: "selectPane", pane: 1 }]);

test("ADR 0087 I6: the preview tab selected, a sheet opened from the tree: the followed tab takes it and is selected; the preview tab stays", () => {
  const s = check([{ type: "open", docs: [doc(B)] }], withPreviewSelected());
  assert.deepEqual(paths(s), [[B], ["preview"]]);
  assert.equal(s.pane, 0);
  assert.equal(name(s, s.followed), B);
  assert.equal(focused(s)?.path, B);
});

test("ADR 0087 I6: the preview tab selected, a sheet already open: its tab is selected; the preview tab stays", () => {
  const s0 = check([{ type: "open", docs: [doc(B)], newTab: true }], check([{ type: "open", docs: [doc(A)] }, { type: "open", docs: [doc(C)], newTab: true }, { type: "showPreview", mode: "plain" }, { type: "selectPane", pane: 1 }]));
  const s = check([{ type: "selectPane", pane: 1 }, { type: "open", docs: [doc(A)] }], s0);
  assert.deepEqual(paths(s), [[A, C, B], ["preview"]]);
  assert.equal(s.pane, 0);
  assert.equal(s.panes[0].active, 0);
  assert.equal(previews(s), 1);
});

test("ADR 0087 I6: the preview tab selected, a new tab: it opens after the followed tab, selected; the preview tab stays", () => {
  const s0 = check([{ type: "open", docs: [doc(A)] }, { type: "open", docs: [doc(B)], newTab: true }, { type: "selectTab", pane: 0, index: 0 }, { type: "showPreview", mode: "plain" }, { type: "selectPane", pane: 1 }]);
  const s = check([{ type: "open", docs: [doc(C)], newTab: true }], s0);
  assert.deepEqual(paths(s), [[A, C, B], ["preview"]]);
  assert.equal(s.pane, 0);
  assert.equal(s.panes[0].active, 1);
  assert.equal(name(s, s.followed), C);
});

test("ADR 0087 I6: two panes, left [plot], right [preview (selected)], nothing followed: a sheet opens at the end of the left pane", () => {
  const s0 = check([restore([{ tabs: [plotTab("/w/p")], active: 0 }, { tabs: [previewTab], active: 0 }], 1)]);
  assert.equal(s0.followed, null);
  for (const newTab of [false, true]) {
    const s = check([{ type: "open", docs: [doc(A)], newTab }], s0);
    assert.deepEqual(paths(s), [["plot:/w/p", A], ["preview"]]);
    assert.equal(s.pane, 0);
    assert.equal(s.panes[0].active, 1);
  }
});

test("ADR 0087 I6: one pane of the preview tab alone, nothing followed: a sheet opens after the preview tab", () => {
  const s0 = check([restore([{ tabs: [previewTab], active: 0 }], 0)]);
  for (const newTab of [false, true]) {
    const s = check([{ type: "open", docs: [doc(A)], newTab }], s0);
    assert.deepEqual(paths(s), [["preview", A]]);
    assert.equal(s.panes[0].active, 1);
  }
});

test("ADR 0087 I6: the preview tab selected, view.plot: the followed tab becomes the plot; the preview tab stays", () => {
  const s = check([{ type: "plot", project: "/w/p" }], withPreviewSelected());
  assert.deepEqual(paths(s), [["plot:/w/p"], ["preview"]]);
  assert.equal(previews(s), 1);
});

// ---- closing and moving (I1, I4)

test("ADR 0087 I4: closing the preview tab that was alone in the right pane ends the split", () => {
  const s = check([{ type: "closeTab", pane: 1, index: 0 }], withPreviewSelected());
  assert.deepEqual(paths(s), [[A]]);
  assert.equal(s.pane, 0);
});

test("ADR 0087 I1, I4: dragging the preview tab to the left pane empties the right one: the split ends with one preview tab", () => {
  const s = check([{ type: "moveTab", from: { pane: 1, index: 0 }, to: { pane: 0, index: 1 } }], withPreviewSelected());
  assert.deepEqual(paths(s), [[A, "preview"]]);
  assert.equal(previews(s), 1);
});

// ---- the tabs kept between launches (I2, I8)

test("ADR 0087 I2: one pane [chapter 1, preview (selected)] written and restored: chapter 1 is followed", () => {
  const s0 = check([restore([{ tabs: [sheet(ch1), previewTab], active: 1 }], 0)]);
  const w = readTabs(JSON.parse(JSON.stringify(writeTabs(s0))))!;
  assert.deepEqual(w, { pane: 0, panes: [{ active: 1, tabs: [{ paths: [ch1], focus: 0 }, { preview: true }] }] });
  const panes = w.panes.map((p) => ({ active: p.active, tabs: p.tabs.map((t) => ("preview" in t ? previewTab : "plot" in t ? plotTab(t.plot) : { open: t.paths.map(doc), focus: t.focus, plot: null })) }));
  const s = check([restore(panes, w.pane)]);
  assert.equal(activeTab(s).preview, true);
  assert.equal(name(s, s.followed), ch1);
});

test("ADR 0087 I1, I8: two preview tabs kept: only the first is read back", () => {
  const t = readTabs({ pane: 0, panes: [{ active: 0, tabs: [{ paths: [A], focus: 0 }, { preview: true }] }, { active: 0, tabs: [{ preview: true }, { paths: [B], focus: 0 }] }] });
  assert.deepEqual(t, { pane: 0, panes: [{ active: 0, tabs: [{ paths: [A], focus: 0 }, { preview: true }] }, { active: 0, tabs: [{ paths: [B], focus: 0 }] }] });
});

test("ADR 0087 I8: the sheet before the kept preview tab is gone: the preview tab stays and the order of the rest is kept", () => {
  const t: TabsUi = { pane: 0, panes: [{ active: 1, tabs: [{ paths: [A], focus: 0 }, { preview: true }, { paths: [B], focus: 0 }] }] };
  assert.deepEqual(dropMissing(t, (p) => p !== A), { pane: 0, panes: [{ active: 0, tabs: [{ preview: true }, { paths: [B], focus: 0 }] }] });
});

test("ADR 0087 I8: nothing kept: previewMode is \"plain\"", () => {
  assert.equal(initialState().previewMode, "plain");
  assert.equal(readPreviewMode(undefined), "plain");
});

test("ADR 0087 I8: a kept previewMode of \"none\" is read as \"plain\"", () => {
  assert.equal(readPreviewMode("none"), "plain");
  assert.equal(readPreviewMode("pages"), "pages");
  assert.equal(readPreviewMode("plain"), "plain");
});

test("ADR 0087 I8: the old key side of \"none\" is read as \"plain\"", () => {
  assert.equal(readPreviewMode(readUi({ side: "none" }).previewMode), "plain");
  assert.equal(readPreviewMode(readUi({ side: "pages" }).previewMode), "pages");
});

test("ADR 0087 I8: an unknown kept previewMode is read as \"plain\"", () => {
  for (const v of ["side", "", 1, null, { mode: "pages" }]) assert.equal(readPreviewMode(v), "plain");
});

// ---- what the preview tab shows (I9)

test("ADR 0087 I9: a .gm followed with \"pages\": the pages", () => {
  assert.equal(previewShows({ kind: "gm" }, "pages"), "pages");
  assert.equal(previewShows({ kind: "gm" }, "plain"), "plain");
});

test("ADR 0087 I9: a .md followed with \"pages\": the text", () => {
  assert.equal(previewShows({ kind: "md" }, "pages"), "plain");
  assert.equal(previewShows({ kind: "md" }, "plain"), "plain");
});

test("ADR 0087 I9: a .svg or Mermaid sheet: the figure, whatever the mode", () => {
  for (const kind of ["svg", "mmd"]) for (const mode of ["plain", "pages"] as const) assert.equal(previewShows({ kind }, mode), "figure");
});

test("ADR 0087 I9: a .csv sheet: the line that it has no preview", () => {
  assert.equal(previewShows({ kind: "csv" }, "plain"), "none");
  assert.equal(previewMessage("none"), NO_PREVIEW);
  assert.equal(NO_PREVIEW, "このシートにはプレビューがありません");
});

test("ADR 0087 I9: no followed sheet: the line that asks for a sheet", () => {
  assert.equal(previewShows(null, "pages"), "empty");
  assert.equal(previewMessage("empty"), PICK_SHEET);
  assert.equal(PICK_SHEET, "シートを選ぶと、ここにプレビューが出ます");
});

// ---- the pages built again after a save (I10)

const saved = (o: Partial<Parameters<typeof rebuildPagesOnSave>[0]>) =>
  rebuildPagesOnSave({ setting: true, kind: "gm", hasPages: false, previewTab: false, mode: "plain", ...o });

test("ADR 0087 I10: the setting off, a .gm with pages built before: not built again", () => {
  assert.equal(saved({ setting: false, hasPages: true }), false);
  assert.equal(saved({ setting: false, previewTab: true, mode: "pages" }), false);
});

test("ADR 0087 I10: the setting on, a .gm saved, no pages before, the preview tab open with \"pages\": built again", () => {
  assert.equal(saved({ previewTab: true, mode: "pages" }), true);
  assert.equal(saved({ hasPages: true }), true);
  assert.equal(saved({ previewTab: true, mode: "plain" }), false);
});

test("ADR 0087 I10: the setting on, a .gm saved, no pages before, no preview tab: not built again", () => {
  assert.equal(saved({ previewTab: false, mode: "pages" }), false);
});

test("ADR 0087 I10: the setting on, a .md saved: not built again", () => {
  assert.equal(saved({ kind: "md", hasPages: true, previewTab: true, mode: "pages" }), false);
});
