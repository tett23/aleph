import type { GitDiff, GitDiffSpan, GitStatus } from "./git-ipc.ts";
import { readStructuredDiff } from "./difftab/text.ts";
// The diff tab and the commit before applying the assistant's edits (docs/adr/0088): the tab in the
// panes, reading `git status` and `git diff` into the list of files, the decision before applying,
// the commit message, and showing the diff tab after applying.
import { test } from "node:test";
import assert from "node:assert/strict";
import { diffAvailable, diffSelected, initialState, readTabs, reduce, writeTabs, type Action, type Doc, type State } from "./store.ts";
import { MAX_FILES, MAX_LINES, changeKind, diffFiles } from "./difftab/read.ts";
import { diffTextHtml } from "./difftab/text.ts";
import { applyDecision, commitMessage, hasChanges } from "./difftab/apply.ts";
import { holdModal, modalKey } from "./difftab/modal.ts";

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
const paths = (s: State) => s.panes.map((p) => p.tabs.map((t) => (t.diff ? "diff" : t.preview ? "preview" : t.plot ? `plot:${t.plot}` : t.open.map((d) => d.path).join("+"))));
const diffs = (s: State) => s.panes.flatMap((p) => p.tabs).filter((t) => t.diff);
const activeTab = (s: State) => s.panes[s.pane].tabs[s.panes[s.pane].active];
const name = (s: State, id: number | null) => {
  if (id === null) return null;
  const t = s.panes.flatMap((p) => p.tabs).find((x) => x.id === id);
  return t ? t.open.map((d) => d.path).join("+") : `missing:${id}`;
};

/** I1 and I3, checked on every state a test reaches. */
const invariants = (s: State) => {
  assert.ok(diffs(s).length <= 1, "I1: at most one diff tab");
  assert.ok(!diffs(s).some((t) => t.id === s.followed), "I3: the diff tab is never followed");
  return s;
};
const check = (actions: Action[], from: State = initialState()) => invariants(run(actions, from));

const ws: Action = { type: "workspace", path: "/w" };
const ch1 = "/w/p/01.gm", ch2 = "/w/p/02.gm", A = "/w/a.md", B = "/w/b.md";
const sheet = (path: string) => ({ open: [doc(path)], focus: 0, plot: null });
const diffTab = { open: [], focus: 0, plot: null, diff: true };
const restore = (panes: Extract<Action, { type: "restoreTabs" }>["panes"], pane: number): Action => ({ type: "restoreTabs", panes, pane });

// ---- view.diff (I1, I2)

test("ADR 0088 I2: no workspace: view.diff is not available and changes nothing", () => {
  const s = initialState();
  assert.equal(diffAvailable(s), false);
  assert.equal(run([{ type: "showDiff" }], s), s);
});

test("ADR 0088 I1, I2: no tab: view.diff opens the diff tab as the only tab, selected", () => {
  const before = check([ws]);
  assert.equal(diffAvailable(before), true);
  const s = check([{ type: "showDiff" }], before);
  assert.deepEqual(paths(s), [["diff"]]);
  assert.equal(activeTab(s).diff, true);
  assert.equal(diffSelected(s), true);
});

test("ADR 0088 I1, I2: one pane [chapter 1]: view.diff makes [chapter 1, diff] with the diff tab selected", () => {
  const s = check([ws, { type: "open", docs: [doc(ch1)] }, { type: "showDiff" }]);
  assert.deepEqual(paths(s), [[ch1, "diff"]]);
  assert.equal(s.panes[0].active, 1);
  assert.equal(diffSelected(s), true);
});

test("ADR 0088 I1, I2: the diff tab in the pane not selected: view.diff selects that pane and the diff tab in it", () => {
  const before = check([ws, restore([{ tabs: [sheet(A)], active: 0 }, { tabs: [diffTab, sheet(B)], active: 1 }], 0)]);
  const s = check([{ type: "showDiff" }], before);
  assert.equal(s.pane, 1);
  assert.equal(s.panes[1].active, 0);
  assert.equal(diffSelected(s), true);
  assert.deepEqual(paths(s), [[A], ["diff", B]]);
});

test("ADR 0088 I1, I2: view.diff again adds no tab", () => {
  const once = check([ws, { type: "open", docs: [doc(ch1)] }, { type: "showDiff" }]);
  const twice = check([{ type: "selectTab", pane: 0, index: 0 }, { type: "showDiff" }, { type: "showDiff" }], once);
  assert.equal(diffs(twice).length, 1);
  assert.deepEqual(paths(twice), [[ch1, "diff"]]);
  assert.equal(diffSelected(twice), true);
});

// ---- the followed tab (I3)

test("ADR 0088 I3: [chapter 1, diff], chapter 1 selected then the diff tab: chapter 1's tab stays followed", () => {
  const s0 = check([ws, { type: "open", docs: [doc(ch1)] }, { type: "showDiff" }, { type: "selectTab", pane: 0, index: 0 }]);
  const s = check([{ type: "selectTab", pane: 0, index: 1 }], s0);
  assert.equal(diffSelected(s), true);
  assert.equal(name(s, s.followed), ch1);
});

test("ADR 0088 I3: the diff tab left alone: nothing is followed", () => {
  const s = check([ws, { type: "open", docs: [doc(ch1)] }, { type: "showDiff" }, { type: "closeTab", pane: 0, index: 0 }]);
  assert.deepEqual(paths(s), [["diff"]]);
  assert.equal(s.followed, null);
});

// ---- opening while the diff tab is selected (I4)

test("ADR 0088 I4: the diff tab selected, a followed tab there: a sheet opened from the tree replaces the followed tab's content; the diff tab stays", () => {
  const s0 = check([ws, { type: "open", docs: [doc(ch1)] }, { type: "showDiff" }]);
  const s = check([{ type: "open", docs: [doc(ch2)] }], s0);
  assert.deepEqual(paths(s), [[ch2, "diff"]]);
  assert.equal(s.panes[0].active, 0);
  assert.equal(name(s, s.followed), ch2);
  // the names in the diff tab pressed one after another: the followed tab's content changes, the diff tab stays
  const t = check([{ type: "selectTab", pane: 0, index: 1 }, { type: "open", docs: [doc(A)] }, { type: "selectTab", pane: 0, index: 1 }, { type: "open", docs: [doc(B)] }], s);
  assert.deepEqual(paths(t), [[B, "diff"]]);
});

test("ADR 0088 I4: the diff tab selected, nothing followed, one pane: a sheet opens in a new tab after the diff tab", () => {
  const s0 = check([ws, { type: "showDiff" }]);
  for (const newTab of [false, true]) {
    const s = check([{ type: "open", docs: [doc(A)], newTab }], s0);
    assert.deepEqual(paths(s), [["diff", A]]);
    assert.equal(s.panes[0].active, 1);
  }
});

test("ADR 0088 I4: the diff tab selected, nothing followed, two panes: a sheet opens at the end of the other pane", () => {
  const s0 = check([ws, restore([{ tabs: [diffTab], active: 0 }, { tabs: [{ open: [], focus: 0, plot: "/w/p" }], active: 0 }], 0)]);
  assert.equal(s0.followed, null);
  const s = check([{ type: "open", docs: [doc(A)] }], s0);
  assert.deepEqual(paths(s), [["diff"], ["plot:/w/p", A]]);
  assert.equal(s.pane, 1);
});

test("ADR 0088 I4: the diff tab selected, view.plot: the diff tab stays", () => {
  const s0 = check([ws, { type: "open", docs: [doc(ch1)] }, { type: "showDiff" }]);
  const s = check([{ type: "plot", project: "/w/p" }], s0);
  assert.deepEqual(paths(s), [["plot:/w/p", "diff"]]);
  assert.equal(diffs(s).length, 1);
});

// ---- the tabs kept between launches (I1, I8)

test("ADR 0088 I8: the diff tab is written as { diff: true } and read back", () => {
  const s0 = check([ws, { type: "open", docs: [doc(ch1)] }, { type: "showDiff" }]);
  const w = readTabs(JSON.parse(JSON.stringify(writeTabs(s0))));
  assert.deepEqual(w, { pane: 0, panes: [{ active: 1, tabs: [{ paths: [ch1], focus: 0 }, { diff: true }] }] });
  const s = check([restore([{ tabs: [sheet(ch1), diffTab], active: 1 }], 0)], check([ws]));
  assert.equal(diffSelected(s), true);
  assert.equal(name(s, s.followed), ch1);
});

test("ADR 0088 I1, I8: two diff tabs kept: only the first is read back", () => {
  const t = readTabs({ pane: 0, panes: [{ active: 1, tabs: [{ paths: [A], focus: 0 }, { diff: true }] }, { active: 1, tabs: [{ diff: true }, { paths: [B], focus: 0 }] }] });
  assert.deepEqual(t, { pane: 0, panes: [{ active: 1, tabs: [{ paths: [A], focus: 0 }, { diff: true }] }, { active: 0, tabs: [{ paths: [B], focus: 0 }] }] });
});

// ---- the decision before applying (I5)

const decide = (o: Partial<Parameters<typeof applyDecision>[0]>) => applyDecision({ git: true, repo: true, inWorkspace: true, changed: true, ...o });

test("ADR 0088 I5: git, a repository, the sheet in the workspace, one sheet not saved: ask to commit", () => {
  assert.equal(hasChanges(1, 0), true);
  assert.equal(decide({ changed: hasChanges(1, 0) }), "commit");
});

test("ADR 0088 I5: the same with no sheet unsaved and one entry of git status: ask to commit", () => {
  assert.equal(hasChanges(0, 1), true);
  assert.equal(decide({ changed: hasChanges(0, 1) }), "commit");
});

test("ADR 0088 I5: the same with neither: apply as it is", () => {
  assert.equal(hasChanges(0, 0), false);
  assert.equal(decide({ changed: hasChanges(0, 0) }), "apply");
});

test("ADR 0088 I5: the sheet in the shared library: say it cannot be undone with Git", () => {
  assert.equal(decide({ inWorkspace: false }), "irreversible");
  assert.equal(decide({ inWorkspace: false, changed: false }), "irreversible");
});

test("ADR 0088 I5: not a repository: say it cannot be undone with Git", () => {
  assert.equal(decide({ repo: false }), "irreversible");
  assert.equal(decide({ repo: false, changed: false }), "irreversible");
});

test("ADR 0088 I5: no git, or git status failed: say it cannot be undone with Git", () => {
  assert.equal(decide({ git: false }), "irreversible");
  assert.equal(decide({ git: false, changed: false }), "irreversible");
  assert.equal(decide({ changed: null }), "irreversible");
});

// ---- reading the diff (I6, I7)

const hunk = (body: string[]) => ["diff --git a/x b/x", "index 1111111..2222222 100644", "--- a/x", "+++ b/x", "@@ -1,2 +1,2 @@", ...body].join("\n") + "\n";
const patchFixture = (ordinary: string): GitDiff => {
  const hunks: { heading: string; lines: GitDiffSpan[] }[] = [];
  let added = 0;
  let removed = 0;
  for (const line of ordinary.split("\n")) {
    if (line.startsWith("@@ ")) hunks.push({ heading: line, lines: [] });
    else if (hunks.length && /^[ +\-]/.test(line)) {
      const kind = line[0] === " " ? "same" : line[0] === "+" ? "added" : "removed";
      hunks.at(-1)!.lines.push({ kind, text: line.slice(1) + "\n" });
      if (kind === "added") added++;
      if (kind === "removed") removed++;
    }
  }
  return { body: hunks.length ? "lines" : ordinary.includes("Binary files ") ? "binary" : "empty", hunks, added, removed };
};
const fixtureRead = (ordinary: string) => readStructuredDiff(patchFixture(ordinary), MAX_LINES);
const statusFixture = (z: string): GitStatus[] => {
  const parts = z.split("\0");
  const entries: GitStatus[] = [];
  for (let i = 0; i < parts.length && parts[i]; i++) {
    const xy = parts[i].slice(0, 2);
    const path = parts[i].slice(3);
    entries.push(xy.startsWith("R") ? { xy, path, from: parts[++i] } : { xy, path });
  }
  return entries;
};
const diffFixture = (z: string, diffs: ReadonlyMap<string, GitDiff>) => diffFiles(statusFixture(z), diffs);
const one = (z: string, diff: string) => {
  const [entry] = statusFixture(z);
  return diffFiles([entry], new Map([[entry.path, patchFixture(diff)]])).files[0];
};

test("ADR 0088 I6: an empty git status: no file", () => {
  assert.deepEqual(diffFixture("", new Map()), { files: [], moreFiles: 0 });
});

test("ADR 0105 I5: one file ` M`: a change, with the + and - after @@ counted", () => {
  const f = one(" M a.txt\0", hunk(["-old", "+new", "+more", " same"]));
  assert.equal(f.path, "a.txt");
  assert.equal(f.kind, "変更");
  assert.equal(f.added, 2);
  assert.equal(f.removed, 1);
  assert.equal(f.body, "lines");
  assert.equal(diffTextHtml(f.lines), '<span class="d-hunk">@@ -1,2 +1,2 @@</span>\n<del class="d-word-del">old</del><ins class="d-word-add">new</ins>\n<ins class="d-word-add">more</ins>\nsame\n');
  assert.equal(f.moreLines, 0);
  assert.equal(f.openable, true);
});

test("ADR 0088 I6: one file `??`: added, every line of it added", () => {
  const out = "diff --git a/n.txt b/n.txt\nnew file mode 100644\nindex 0000000..45b983b\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,3 @@\n+a\n+b\n+c\n";
  const f = one("?? n.txt\0", out);
  assert.equal(f.kind, "追加");
  assert.equal(f.added, 3);
  assert.equal(f.removed, 0);
});

test("ADR 0088 I6: `AM`: added", () => {
  assert.equal(changeKind("AM"), "追加");
  assert.equal(one("AM a.txt\0", hunk(["+x"])).kind, "追加");
});

test("ADR 0088 I6: ` D`: deleted, removed lines only, and its name cannot be pressed", () => {
  const f = one(" D a.txt\0", "diff --git a/a.txt b/a.txt\ndeleted file mode 100644\n--- a/a.txt\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n");
  assert.equal(f.kind, "削除");
  assert.equal(f.added, 0);
  assert.equal(f.removed, 2);
  assert.equal(f.openable, false);
  assert.equal(changeKind("D "), "削除");
});

test("ADR 0088 I6: `R ` with the path before: renamed, with the new path and the path before", () => {
  const z = "R  s.txt\0r.txt\0";
  const [e] = statusFixture(z);
  assert.deepEqual([e.path, e.from], ["s.txt", "r.txt"]);
  const f = diffFixture(z, new Map([["s.txt", patchFixture(hunk(["+l4"]))]])).files[0];
  assert.equal(f.kind, "名前の変更");
  assert.equal(f.path, "s.txt");
  assert.equal(f.from, "r.txt");
  assert.equal(f.added, 1);
  assert.equal(changeKind("RM"), "名前の変更");
});

test("ADR 0088 I6: `UU`: a conflict, and so are the others of the table's first row", () => {
  for (const xy of ["UU", "AU", "UA", "DU", "UD", "AA", "DD"]) assert.equal(changeKind(xy), "競合", xy);
  assert.equal(one("UU a.txt\0", hunk(["+x"])).kind, "競合");
});

test("ADR 0088 I6: the rest of the XY table: a tracked file changed is a change", () => {
  for (const xy of [" M", "M ", "MM", " T", "T "]) assert.equal(changeKind(xy), "変更", xy);
  assert.equal(changeKind("??"), "追加");
  assert.equal(changeKind("A "), "追加");
  assert.equal(changeKind("MD"), "削除");
});

test("ADR 0088 I6: literal workspace-relative paths are shown as received", () => {
  const { files } = diffFiles([{ xy: " M", path: "a[1].txt" }], new Map([["a[1].txt", patchFixture(hunk(["+x"]))]]));
  assert.equal(files[0].path, "a[1].txt");
});

test("ADR 0105 I5: a removed line whose content starts with -- (----) is counted as removed", () => {
  const f = one(" M a.txt\0", hunk(["----", "++++", " ---"]));
  assert.equal(f.removed, 1);
  assert.equal(f.added, 1);
  assert.equal(diffTextHtml(f.lines), '<span class="d-hunk">@@ -1,2 +1,2 @@</span>\n<del class="d-word-del">---</del><ins class="d-word-add">+++</ins>\n---\n');
});

test("ADR 0105 I5: hunk headings and the full line counts are retained", () => {
  const r = fixtureRead("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n@@ -9 +9 @@\n+c\n");
  assert.equal(r.lines.length, 4);
  assert.deepEqual(r.lines.flatMap((line) => line.kind === "hunk" ? [line.text] : []), ["@@ -1 +1 @@", "@@ -9 +9 @@"]);
  assert.equal(r.added, 2);
  assert.equal(r.removed, 1);
});

test("ADR 0088 I6: `Binary files … differ`: binary, with no line shown", () => {
  const f = one(" M i.png\0", "diff --git a/i.png b/i.png\nindex 1..2 100644\nBinary files a/i.png and b/i.png differ\n");
  assert.equal(f.body, "binary");
  assert.deepEqual(f.lines, []);
  assert.equal(f.added + f.removed, 0);
});

test("ADR 0088 I6: `?? dir/` (a nested repository): a folder, with no line shown and no diff read", () => {
  const f = diffFixture("?? dir/\0", new Map()).files[0];
  assert.equal(f.kind, "追加");
  assert.equal(f.body, "folder");
  assert.deepEqual(f.lines, []);
  assert.equal(f.openable, false);
});

test("ADR 0088 I6: an empty diff: no difference", () => {
  assert.equal(one(" M a.txt\0", "").body, "empty");
});

test("ADR 0088 I6: no commit yet: every file is read as added lines", () => {
  const z = "A  a.txt\0?? b.txt\0";
  const es = statusFixture(z);
  const added = (p: string) => `diff --git a/${p} b/${p}\nnew file mode 100644\n--- /dev/null\n+++ b/${p}\n@@ -0,0 +1,2 @@\n+1\n+2\n`;
  const r = diffFixture(z, new Map(es.map((e) => [e.path, patchFixture(added(e.path))])));
  assert.deepEqual(r.files.map((f) => [f.path, f.kind, f.added, f.removed]), [["a.txt", "追加", 2, 0], ["b.txt", "追加", 2, 0]]);
});

test("ADR 0088 I6: the files are in the order of git status", () => {
  const z = " M c.txt\0?? a.txt\0 D b.txt\0";
  assert.deepEqual(diffFixture(z, new Map()).files.map((f) => f.path), ["c.txt", "a.txt", "b.txt"]);
});

const long = (n: number) => ["@@ -0,0 +1 @@", ...Array.from({ length: n - 1 }, (_, k) => `+${k}`)].join("\n") + "\n";

test("ADR 0096 I4: exactly 2,000 lines to show: all of them, none more", () => {
  assert.equal(MAX_LINES, 2000);
  const r = fixtureRead(long(2000));
  assert.equal(r.lines.length, 2000);
  assert.equal(r.moreLines, 0);
  assert.equal(r.added, 1999);
});

test("ADR 0096 I4: 2,001 lines: 2,000 of them and 1 more, counted before the cut", () => {
  const r = fixtureRead(long(2001));
  assert.equal(r.lines.length, 2000);
  assert.equal(r.moreLines, 1);
  assert.equal(r.added, 2000);
});

const many = (n: number) => Array.from({ length: n }, (_, k) => `?? f${k}.txt\0`).join("");

test("ADR 0088 I7: exactly 200 files: all listed, none more", () => {
  assert.equal(MAX_FILES, 200);
  const r = diffFixture(many(200), new Map());
  assert.equal(r.files.length, 200);
  assert.equal(r.moreFiles, 0);
});

test("ADR 0088 I7: 201 files: 200 and 1 more", () => {
  const r = diffFixture(many(201), new Map());
  assert.equal(r.files.length, 200);
  assert.equal(r.moreFiles, 1);
});

// ---- showing the diff tab after applying (I11)

const after: Action = { type: "showDiffAfterApply" };

test("ADR 0088 I11: one pane [chapter 1]: a right pane is made with the diff tab selected; the left pane stays selected", () => {
  const s = check([ws, { type: "open", docs: [doc(ch1)] }, after]);
  assert.deepEqual(paths(s), [[ch1], ["diff"]]);
  assert.equal(s.pane, 0);
  assert.equal(s.panes[1].active, 0);
});

test("ADR 0088 I11: one pane [chapter 1, diff] with chapter 1 selected: the diff tab moves to a new right pane, selected; the left is [chapter 1]", () => {
  const s = check([ws, { type: "open", docs: [doc(ch1)] }, { type: "showDiff" }, { type: "selectTab", pane: 0, index: 0 }, after]);
  assert.deepEqual(paths(s), [[ch1], ["diff"]]);
  assert.equal(s.pane, 0);
  assert.equal(s.panes[0].active, 0);
  assert.equal(s.panes[1].active, 0);
});

test("ADR 0088 I11: two panes, the diff tab in the pane not selected: it is selected in that pane", () => {
  const s0 = check([ws, restore([{ tabs: [sheet(A)], active: 0 }, { tabs: [diffTab, sheet(B)], active: 1 }], 0)]);
  const s = check([after], s0);
  assert.deepEqual(paths(s), [[A], ["diff", B]]);
  assert.equal(s.pane, 0);
  assert.equal(s.panes[1].active, 0);
});

test("ADR 0088 I11: two panes, the diff tab in the selected pane: it moves to the end of the other pane, selected there", () => {
  const s0 = check([ws, restore([{ tabs: [sheet(A), diffTab], active: 0 }, { tabs: [sheet(B)], active: 0 }], 0)]);
  const s = check([after], s0);
  assert.deepEqual(paths(s), [[A], [B, "diff"]]);
  assert.equal(s.pane, 0);
  assert.equal(s.panes[0].active, 0);
  assert.equal(s.panes[1].active, 1);
});

test("ADR 0088 I11: two panes and no diff tab: it opens at the end of the pane not selected", () => {
  const s0 = check([ws, restore([{ tabs: [sheet(A)], active: 0 }, { tabs: [sheet(B)], active: 0 }], 1)]);
  const s = check([after], s0);
  assert.deepEqual(paths(s), [[A, "diff"], [B]]);
  assert.equal(s.pane, 1);
  assert.equal(s.panes[0].active, 1);
});

test("ADR 0088 I11: the diff tab the only tab of the selected pane: it is selected without moving", () => {
  const s0 = check([ws, restore([{ tabs: [diffTab], active: 0 }, { tabs: [sheet(B)], active: 0 }], 0)]);
  const s = check([after], s0);
  assert.deepEqual(paths(s), [["diff"], [B]]);
  assert.equal(s.pane, 0);
  assert.equal(diffSelected(s), true);
});

// ---- the commit message (I12)

test("ADR 0088 I12: 2026-11-18 03:07 gives `Before the assistant's edit 2026-11-18 03:07`", () => {
  assert.equal(commitMessage(new Date(2026, 10, 18, 3, 7)), "Before the assistant's edit 2026-11-18 03:07");
  assert.equal(commitMessage(new Date(2026, 0, 2, 23, 59)), "Before the assistant's edit 2026-01-02 23:59");
});

// ---- the modal dialogs (I10)

test("ADR 0088 I10: the modal flag is set and cleared by the reducer", () => {
  const s = run([{ type: "modal", on: true }]);
  assert.equal(s.modal, true);
  assert.equal(run([{ type: "modal", on: false }], s).modal, false);
  assert.equal(initialState().modal, false);
});

type FakeEl = { name: string; inert: boolean; focused: number; focus: () => void; remove: () => void; removed: boolean };
const fakeEl = (name: string, inert = false): FakeEl => {
  const e: FakeEl = { name, inert, focused: 0, removed: false, focus: () => void e.focused++, remove: () => void (e.removed = true) };
  return e;
};

test("ADR 0088 I10: a modal dialog makes the other children of body inert, focuses its main button, and on close takes back only its inert and gives the focus back", () => {
  const editor = fakeEl("editor");
  const sidebar = fakeEl("sidebar");
  const already = fakeEl("already", true);
  const body: FakeEl[] = [editor, sidebar, already];
  const dim = fakeEl("dim");
  const primary = fakeEl("primary");
  const flags: boolean[] = [];
  const release = holdModal(
    { children: () => [...body], append: (el) => void body.push(el as FakeEl), active: () => editor },
    dim,
    primary,
    (on) => flags.push(on),
  );
  assert.deepEqual(body.map((e) => [e.name, e.inert]), [["editor", true], ["sidebar", true], ["already", true], ["dim", false]]);
  assert.equal(primary.focused, 1);
  assert.deepEqual(flags, [true]);
  release();
  assert.deepEqual([editor.inert, sidebar.inert, already.inert], [false, false, true]);
  assert.equal(dim.removed, true);
  assert.equal(editor.focused, 1);
  assert.deepEqual(flags, [true, false]);
});

test("ADR 0088 I10: Tab and Shift-Tab go round the buttons, Enter presses the focused one, Esc cancels", () => {
  assert.deepEqual(modalKey("Tab", false, 2, 3), { focus: 0 });
  assert.deepEqual(modalKey("Tab", true, 0, 3), { focus: 2 });
  assert.deepEqual(modalKey("Tab", false, 0, 3), { focus: 1 });
  assert.deepEqual(modalKey("Enter", false, 1, 3), { press: 1 });
  assert.deepEqual(modalKey("Escape", false, 1, 3), { cancel: true });
  assert.equal(modalKey("a", false, 1, 3), null);
});
