import assert from "node:assert/strict";
import { test } from "node:test";
import { createProjectInputs, createProjectInputWatch, previewInput } from "./project-inputs.ts";
import { rebuildPagesOnSave } from "./tab.ts";
import { createPageSaves } from "./page-saves.ts";
import { createWaiter } from "./wait.ts";
import { pdfPreviewInput } from "./pages.ts";
import { readChapterXhtml } from "./xhtml.ts";

const project = "/workspace/book";
const emet = project + "/functions/example.emet";
const style = project + "/style.toml";

test("ADR 0113 I1: classify nested Emet and root configuration within the changed project", () => {
  for (const path of [emet, style, project + "/manifest.toml"]) assert.equal(previewInput(project, path), true);
  for (const path of [project + "/other/style.toml", project + "/notes.toml", project + "/build/output.emet", "/workspace/other/style.toml"]) {
    assert.equal(previewInput(project, path), false);
  }
});

test("ADR 0113 I2: compare closed files with the initial snapshot and ignore duplicate notifications", () => {
  const inputs = createProjectInputs();
  inputs.start(new Map([[emet, "old"], [style, "old style"]]));
  assert.deepEqual(inputs.observe(new Map([[emet, "old"]])), []);
  assert.deepEqual(inputs.observe(new Map([[emet, "external"]])), [{ path: emet, before: "old", after: "external" }]);
  assert.deepEqual(inputs.observe(new Map([[emet, "external"]])), []);
  assert.equal(inputs.saved(emet, "old", "external", "explicit"), "promote");
  assert.equal(inputs.saved(emet, "external", "external", "explicit"), null);
  assert.deepEqual(inputs.observe(new Map([[style, null]])), [{ path: style, before: "old style", after: null }]);
  assert.deepEqual(inputs.observe(new Map([[style, "new style"]])), [{ path: style, before: null, after: "new style" }]);
});

test("ADR 0113 I2, I3: intermediate writes are hidden until the final formatted save", () => {
  const inputs = createProjectInputs();
  inputs.start(new Map([[emet, "old"]]));
  assert.equal(inputs.saved(emet, "old", "draft", "intermediate"), null);
  assert.deepEqual(inputs.observe(new Map([[emet, "draft"]])), []);
  assert.deepEqual(inputs.observe(new Map([[emet, "formatted"]]), (path) => path === emet), []);
  assert.equal(inputs.saved(emet, "old", "formatted", "explicit"), "changed");
  assert.deepEqual(inputs.observe(new Map([[emet, "formatted"]])), []);
});

test("ADR 0113 I1, I2: an external batch invalidates only changed inputs of previously built projects", async () => {
  const manifest = project + "/manifest.toml";
  const other = "/workspace/other";
  const disk = new Map([[manifest, "chapters = []"], [emet, "old"], [other + "/manifest.toml", "chapters = []"]]);
  const watch = createProjectInputWatch(async (root) => [...disk.keys()].filter((path) => previewInput(root, path)),
    async (path) => disk.get(path) ?? null);
  await Promise.all([watch.start(project), watch.start(other)]);
  const changed: string[] = [];
  const apply = (_project: string, changes: { path: string }[]) => changed.push(...changes.map((change) => change.path));
  await watch.changed([emet], [], apply);
  assert.deepEqual(changed, []);
  disk.set(emet, "external edit");
  await watch.changed([emet, other + "/manifest.toml"], [], apply);
  assert.deepEqual(changed, [emet]);
  disk.delete(emet);
  await watch.changed([], [project + "/functions"], apply);
  assert.deepEqual(changed, [emet, emet]);
});

test("ADR 0113 I3: existing pages, the first build, and the followed project decide page eligibility", () => {
  const defaults = { setting: true, kind: "toml", hasPages: false, previewTab: true, mode: "pages" as const, input: true };
  assert.equal(rebuildPagesOnSave(defaults), false);
  assert.equal(rebuildPagesOnSave({ ...defaults, followsProject: true }), true);
  assert.equal(rebuildPagesOnSave({ ...defaults, initialBuild: true }), true);
  assert.equal(rebuildPagesOnSave({ ...defaults, hasPages: true, setting: false }), false);
});

test("ADR 0113 I3, I4: promote a pending external update and coalesce saved inputs by project", () => {
  let now = 100;
  let next = 0;
  const timers = new Map<number, { fn: () => void; at: number }>();
  const waiter = createWaiter({
    now: () => now,
    set: (fn, ms) => { timers.set(++next, { fn, at: now + ms }); return next; },
    clear: (id) => { timers.delete(id); },
  });
  const tick = (ms: number) => {
    now += ms;
    for (const [id, timer] of timers) {
      if (timer.at > now) continue;
      timers.delete(id);
      timer.fn();
    }
  };
  const saves = createPageSaves(waiter);
  const requests: string[] = [];
  const request = () => { if (saves.inputsFor(project).changed()) requests.push(project); };
  waiter.edited(project);
  saves.change(project, [{ path: emet, before: "old", after: "final" }], "wait", request);
  tick(4999);
  assert.deepEqual(requests, []);
  saves.change(project, [], "now", request);
  assert.deepEqual(requests, [project]);
  tick(1);
  assert.deepEqual(requests, [project]);
  const inputs = saves.inputsFor(project);
  const built = inputs.snapshot();
  saves.change(project, [{ path: style, before: null, after: "temporary" }], "wait", request);
  saves.change(project, [{ path: style, before: "temporary", after: null }], "wait", request);
  inputs.publish(built);
  tick(5000);
  assert.deepEqual(requests, [project]);
});

test("ADR 0113 I5: chapter order, orientation, and width use the current manifest and style", () => {
  const manifest = 'chapters = ["b.gm", "a.gm"]';
  const style = '[page]\nsize = "A4"\nwriting-mode = "vertical"';
  const inputs = pdfPreviewInput(project, manifest, style);
  assert.deepEqual(inputs.paths, [project + "/b.gm", project + "/a.gm"]);
  assert.equal(inputs.vertical, true);
  assert.equal(inputs.inches, 210 / 25.4);
});

test("ADR 0113 I6: removing a chapter makes any leftover XHTML ineligible", async () => {
  const chapter = project + "/a.gm";
  let reads = 0;
  const read = async () => { reads++; return "old XHTML"; };
  assert.equal(await readChapterXhtml(new Set([chapter]), chapter, read), "old XHTML");
  assert.equal(await readChapterXhtml(new Set(), chapter, read), null);
  assert.equal(reads, 1);
});
