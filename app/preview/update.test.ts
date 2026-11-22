import assert from "node:assert/strict";
import test from "node:test";
import { createPreviewFeed, createPreviewUpdates, limitPosition, positionOf, previewKey, type PreviewTarget } from "./update.ts";

const target: PreviewTarget = { workspace: "/w", project: "/w/book", paths: ["/w/book/a.gm", "/w/book/b.gm"], mode: "plain", vertical: true };

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

test("ADR 0097 I1, I2: positions clamp in logical coordinates and ordered targets have distinct keys", () => {
  assert.deepEqual(positionOf(-60, 31, true), { x: 60, y: 31 });
  assert.deepEqual(limitPosition({ x: 60, y: 31 }, { x: 19, y: 0 }), { x: 19, y: 0 });
  assert.notEqual(previewKey(target), previewKey({ ...target, paths: [...target.paths].reverse() }));
  assert.notEqual(previewKey(target), previewKey({ ...target, vertical: false }));
  assert.notEqual(previewKey(target), previewKey({ ...target, mode: "pages" }));
  assert.notEqual(previewKey(target), previewKey({ ...target, workspace: "/different" }));
  assert.notEqual(previewKey(target), previewKey({ ...target, project: "/different" }));
});

const view = () => {
  let position = { x: 0, y: 0 };
  let max = { x: 500, y: 500 };
  let drawn = "";
  const failures: { error: unknown; empty: boolean }[] = [];
  const disposed: string[] = [];
  const updates = createPreviewUpdates({
    read: () => position,
    write: (desired) => position = limitPosition(desired, max),
    max: () => max,
    failed: (error, empty) => failures.push({ error, empty }),
  });
  const loaded = (name: string, dims = max, ready?: Promise<void>) => ({
    mount: () => { drawn = name; max = dims; position = { x: 0, y: 0 }; return ready; },
    dispose: () => disposed.push(name),
  });
  return {
    updates, loaded, failures, disposed, position: () => position, drawn: () => drawn,
    scroll: (x: number, y: number) => { position = { x, y }; updates.scrolled(); },
    max: (x: number, y: number) => { max = { x, y }; },
  };
};

test("ADR 0097 I1, I3: update samples just before mounting and waits for layout without undoing a later scroll", async () => {
  const v = view();
  await v.updates.request(target, 1, async () => v.loaded("old"));
  v.scroll(50, 55);
  const load = deferred<ReturnType<typeof v.loaded>>();
  const ready = deferred<void>();
  const pending = v.updates.request(target, 2, () => load.promise);
  v.scroll(400, 420);
  load.resolve(v.loaded("new", { x: 100, y: 110 }, ready.promise));
  await Promise.resolve();
  assert.deepEqual(v.position(), { x: 100, y: 110 });
  v.max(500, 500);
  ready.resolve();
  await pending;
  assert.deepEqual(v.position(), { x: 400, y: 420 });
  const late = deferred<void>();
  const next = v.updates.request(target, 3, async () => v.loaded("latest", { x: 100, y: 110 }, late.promise));
  await Promise.resolve();
  v.scroll(40, 65);
  v.max(500, 500);
  late.resolve();
  await next;
  assert.deepEqual(v.position(), { x: 40, y: 65 });
});

test("ADR 0097 I2, I4: stale and disposed work cannot mount, and current failures preserve good content", async () => {
  const v = view();
  await v.updates.request(target, 1, async () => { throw "first"; });
  assert.deepEqual(v.failures, [{ error: "first", empty: true }]);
  await v.updates.request(target, 2, async () => v.loaded("old"));
  v.scroll(100, 150);
  const stale = deferred<ReturnType<typeof v.loaded>>();
  const first = v.updates.request(target, 3, () => stale.promise);
  await v.updates.request(target, 4, async () => { throw "images"; });
  stale.resolve(v.loaded("stale"));
  await first;
  assert.equal(v.drawn(), "old");
  assert.deepEqual(v.position(), { x: 100, y: 150 });
  assert.deepEqual(v.failures.at(-1), { error: "images", empty: false });
  assert.deepEqual(v.disposed, ["stale"]);
  await v.updates.request(target, 3, async () => { throw new Error("older generation ran"); });
  const other = { ...target, paths: ["/other.gm"] };
  await v.updates.request(other, 5, async () => v.loaded("other"));
  assert.deepEqual(v.position(), { x: 0, y: 0 });
  const closing = deferred<ReturnType<typeof v.loaded>>();
  const pending = v.updates.request(other, 6, () => closing.promise);
  v.updates.close();
  closing.resolve(v.loaded("closed"));
  await pending;
  assert.equal(v.drawn(), "other");
  assert.deepEqual(v.disposed, ["stale", "old", "other", "closed"]);
});

test("ADR 0097 I2: preview events match their display and reject results for an earlier target", () => {
  const pages = { ...target, mode: "pages" } satisfies PreviewTarget;
  const reordered = { ...pages, paths: [...pages.paths].reverse() };
  const take = createPreviewFeed((t) => t.mode === "pages" && t.project === pages.project && t.workspace === pages.workspace);
  assert.equal(take(pages, 1, false), true);
  assert.equal(take({ ...reordered, workspace: "/elsewhere" }, 3, false), false);
  assert.equal(take(reordered, 2, false), true);
  assert.equal(take(pages, 1, true), false);
  assert.equal(take(pages, 2, true), false);
  assert.equal(take(reordered, 2, true), true);
  assert.equal(take(reordered, 2, true), false);
});

test("ADR 0097 I2, I3: target switches and hidden previews cancel delayed restoration", async () => {
  const v = view();
  await v.updates.request(target, 1, async () => v.loaded("old"));
  v.scroll(200, 210);
  const ready = deferred<void>();
  const pending = v.updates.request(target, 2, async () => v.loaded("narrow", { x: 100, y: 110 }, ready.promise));
  await Promise.resolve();
  v.updates.pause();
  v.max(500, 500);
  ready.resolve();
  await pending;
  assert.deepEqual(v.position(), { x: 100, y: 110 });
  const other = { ...target, vertical: false };
  v.updates.select(other, 3);
  await v.updates.request(target, 4, async () => v.loaded("back"));
  assert.deepEqual(v.position(), { x: 0, y: 0 });
});
