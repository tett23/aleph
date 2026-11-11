import { test } from "node:test";
import assert from "node:assert/strict";
import { createPageInputs, createPageSaves, pageSaveTiming } from "./page-saves.ts";

import { saveSheets } from "../docs.ts";
import { createStore, allDocs, type Doc } from "../store.ts";
import { createWaiter } from "./wait.ts";
import type { SaveOptions } from "../ctx.ts";

test("0072 conditions 1, 3, 4 and 5: schedule only changed final saves of eligible projects", () => {
  assert.equal(pageSaveTiming("explicit", "a", "b", true), "now");
  assert.equal(pageSaveTiming("automatic", "a", "b", true), "wait");
  for (const kind of ["explicit", "automatic"] as const) {
    assert.equal(pageSaveTiming(kind, "a", "a", true), null);
    assert.equal(pageSaveTiming(kind, "a", "b", false), null);
  }
  assert.equal(pageSaveTiming("intermediate", "a", "b", true), null);
});

test("0072 conditions 2 and 5: compare saved content with the last successful build across files", () => {
  const inputs = createPageInputs();
  inputs.save("a", "one", "two");
  inputs.save("a", "two", "one");
  assert.equal(inputs.changed(), false);
  inputs.save("a", "one", "two");
  const running = inputs.snapshot();
  inputs.save("a", "two", "three");
  inputs.save("b", "old", "new");
  inputs.publish(running);
  assert.equal(inputs.changed(), true);
  inputs.save("a", "three", "two");
  assert.equal(inputs.changed(), true);
  inputs.save("b", "new", "old");
  assert.equal(inputs.changed(), false);
});

test("0072 conditions 1–5: successful final saves reach only the intended project's page queue", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 100 });
  const waiter = createWaiter({ now: Date.now, set: (f, ms) => Number(setTimeout(f, ms)), clear: clearTimeout });
  const saves = createPageSaves(waiter);
  const store = createStore();
  const docs: Doc[] = ["/one", "/two"].map((project) => ({
    project, path: project + "/chapter.gm", kind: "gm", text: "old", saved: "old",
    workspace: "/", grid: { chars: 40, lines: 16, vertical: false },
  }));
  store.dispatch({ type: "open", docs });
  const builds: string[] = [];
  store.subscribe((_s, prev, action) => {
    if (action.type !== "saved" && action.type !== "edit") return;
    const doc = allDocs(prev).find((d) => d.path === action.path)!;
    const project = doc.project!;
    if (action.type === "edit") return waiter.edited(project);
    saves.saved(project, action, doc.saved, true, () => {
      const inputs = saves.inputsFor(project);
      if (!inputs.changed()) return;
      builds.push(project);
      inputs.publish(inputs.snapshot());
    });
  });
  const save = (doc: Doc, opts?: SaveOptions, write = async () => true) =>
    saveSheets({ store, editors: new Map() }, [doc.path], opts, write);
  const edit = (doc: Doc, text: string) => store.dispatch({ type: "edit", path: doc.path, text });
  const [one, two] = docs;
  edit(one, "first edit");
  edit(two, "other project");
  await save(one);
  await save(two);
  t.mock.timers.tick(1000);
  await save(one, { explicit: true }); // unchanged: keep original deadline
  assert.deepEqual(builds, []);
  edit(two, "final edit");
  await save(two, { explicit: true, pageSave: "intermediate" });
  assert.deepEqual(builds, []);
  edit(two, "formatted");
  await save(two, { explicit: true, beforeFormat: "other project" });
  assert.deepEqual(builds, ["/two"]);
  t.mock.timers.tick(3999);
  assert.deepEqual(builds, ["/two"]);
  t.mock.timers.tick(1);
  assert.deepEqual(builds, ["/two", "/one"]);
  edit(one, "temporary");
  await save(one);
  edit(one, "first edit");
  await save(one);
  t.mock.timers.tick(5000);
  edit(one, "unsaved");
  await save(one, { explicit: true }, async () => false);
  await assert.rejects(save(one, { explicit: true }, async () => { throw new Error("disk full"); }));
  t.mock.timers.tick(5000);
  assert.deepEqual(builds, ["/two", "/one"]);
  assert.equal(allDocs(store.get()).find((d) => d.path === one.path)?.saved, "first edit");
});
