import { test } from "node:test";
import assert from "node:assert/strict";
import { copyWithProgress, dropResult, dropTarget, PROGRESS_DELAY, progressValue, type Outcome, type Progress } from "./dropin.ts";
import { createNotifications } from "./notify.ts";

// ---- I1: where a drop goes ----

test("ADR 0078 I1: a folder row is the target", () => {
  assert.equal(dropTarget({ kind: "dir", path: "/w/資料" }, "/w"), "/w/資料");
});

test("ADR 0078 I1: a project row is the target", () => {
  assert.equal(dropTarget({ kind: "dir", path: "/w/novel" }, "/w"), "/w/novel");
});

test("ADR 0078 I1, I2: a file row sends the drop to the file's folder", () => {
  assert.equal(dropTarget({ kind: "file", path: "/w/novel/a.md" }, "/w"), "/w/novel");
});

test("ADR 0078 I1: the empty area of the tree sends the drop to the open workspace", () => {
  assert.equal(dropTarget({ kind: "empty" }, "/w"), "/w");
});

test("ADR 0078 I1: the empty area without an open workspace takes nothing", () => {
  assert.equal(dropTarget({ kind: "empty" }, null), null);
});

test("ADR 0078 I1: outside the tree there is no target", () => {
  assert.equal(dropTarget(null, "/w"), null);
});

// ---- I6: the notification after the copy ----

const out = (name: string, error?: string): Outcome => (error ? { name, path: null, error } : { name, path: `/w/${name}`, error: null });

test("ADR 0078 I6: every dropped name appears exactly once, copied or failed", () => {
  const names = ["a.md", "資料", "b.md"];
  const r = dropResult("novel", [out("a.md"), out("資料", "フォルダをその中には落とせません"), out("b.md", "読めません")]);
  for (const n of names) assert.equal(r.message.split(n).length - 1, 1, `${n} once in: ${r.message}`);
  assert.match(r.message, /フォルダをその中には落とせません/);
  assert.match(r.message, /読めません/);
});

test("ADR 0078 I6: a copy with no failure is an info naming the target and the copied", () => {
  const r = dropResult("novel", [out("a.md"), out("b.md")]);
  assert.equal(r.level, "info");
  assert.equal(r.sticky, false);
  assert.match(r.message, /novel/);
  assert.match(r.message, /a\.md、b\.md/);
});

test("ADR 0078 I5, I6: a refused folder alone is an error that stays", () => {
  const r = dropResult("b", [out("a", "フォルダを、そのフォルダ自身かその中には落とせません")]);
  assert.equal(r.level, "error");
  assert.equal(r.sticky, true);
  assert.doesNotMatch(r.message, /コピーしました/);
});

test("ADR 0078 I2, I6: some failed is a warning that stays and lists both", () => {
  const r = dropResult("novel", [out("ok.md"), out("ng.md", "Permission denied")]);
  assert.equal(r.level, "warning");
  assert.equal(r.sticky, true);
  assert.match(r.message, /ok\.md/);
  assert.match(r.message, /ng\.md.*Permission denied/);
});

// ---- I8: the value of the bar ----

const p = (bytes: number, bytesTotal: number, files: number, filesTotal: number): Progress => ({ bytes, bytesTotal, files, filesTotal });

test("ADR 0078 I8: the bar goes by bytes", () => {
  assert.equal(progressValue(p(25, 100, 0, 3)), 0.25);
  assert.equal(progressValue(p(100, 100, 3, 3)), 1);
});

test("ADR 0078 I8: with 0 bytes in all, the bar goes by files", () => {
  assert.equal(progressValue(p(0, 0, 1, 4)), 0.25);
  assert.equal(progressValue(p(0, 0, 4, 4)), 1);
});

test("ADR 0078 I8: the value stays within 0 and 1", () => {
  assert.equal(progressValue(p(0, 0, 0, 0)), 0);
  assert.equal(progressValue(p(200, 100, 0, 0)), 1);
  assert.equal(progressValue(p(-5, 100, 0, 0)), 0);
});

// ---- I7: when the progress toast shows ----

const fakeClock = () => {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    clock: {
      now: () => now,
      set: (fn: () => void, ms: number) => {
        timers.set(++seq, { at: now + ms, fn });
        return seq;
      },
      clear: (id: number) => void timers.delete(id),
    },
    advance: (ms: number) => {
      now += ms;
      for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at))
        if (t.at <= now && timers.has(id)) {
          timers.delete(id);
          t.fn();
        }
    },
  };
};

/** A copy the test ends by hand, reporting progress as it is told. */
const manualCopy = () => {
  let report: (p: Progress) => void = () => {};
  let finish: (o: Outcome[]) => void = () => {};
  const run = (onProgress: (p: Progress) => void) =>
    new Promise<Outcome[]>((resolve) => {
      report = onProgress;
      finish = resolve;
    });
  return { run, report: (x: Progress) => report(x), finish: (o: Outcome[]) => finish(o) };
};

const progressShown = (n: ReturnType<typeof createNotifications>) => n.shown().notes.filter((x) => x.progress);

test("ADR 0078 I7: a copy done at 499 ms shows no progress toast, only the result", async () => {
  const c = fakeClock();
  const n = createNotifications(c.clock);
  const m = manualCopy();
  const done = copyWithProgress({ clock: c.clock, notify: n.notify, key: "copy-1", target: "novel", run: m.run });
  m.report(p(10, 100, 0, 1));
  c.advance(PROGRESS_DELAY - 1);
  assert.equal(progressShown(n).length, 0);
  m.finish([out("a.md")]);
  await done;
  c.advance(10);
  assert.equal(progressShown(n).length, 0);
  assert.deepEqual(
    n.shown().notes.map((x) => x.message.includes("a.md")),
    [true],
  );
});

test("ADR 0078 I7, I8: a copy not done at 500 ms shows the progress toast until it ends, then the result replaces it", async () => {
  const c = fakeClock();
  const n = createNotifications(c.clock);
  const m = manualCopy();
  const done = copyWithProgress({ clock: c.clock, notify: n.notify, key: "copy-1", target: "novel", run: m.run });
  m.report(p(10, 100, 0, 2));
  c.advance(PROGRESS_DELAY);
  assert.equal(progressShown(n).length, 1);
  assert.equal(progressShown(n)[0].progress!.value, 0.1);
  assert.match(progressShown(n)[0].message, /novel/);
  assert.match(progressShown(n)[0].progress!.text, /0 \/ 2/);
  m.report(p(60, 100, 1, 2));
  // updated in place: still one toast
  assert.equal(n.shown().notes.length, 1);
  assert.equal(progressShown(n)[0].progress!.value, 0.6);
  // sticky: long after the timeout it is still there
  c.advance(60_000);
  assert.equal(progressShown(n).length, 1);
  m.report(p(100, 100, 2, 2));
  m.finish([out("a.md"), out("b.md")]);
  await done;
  assert.equal(progressShown(n).length, 0);
  assert.equal(n.shown().notes.length, 1);
  assert.match(n.shown().notes[0].message, /a\.md、b\.md/);
});

test("ADR 0078 I7: closing the progress toast does not bring it back nor stop the copy", async () => {
  const c = fakeClock();
  const n = createNotifications(c.clock);
  const m = manualCopy();
  const done = copyWithProgress({ clock: c.clock, notify: n.notify, key: "copy-1", target: "novel", run: m.run });
  c.advance(PROGRESS_DELAY);
  n.dismiss(progressShown(n)[0].id);
  m.report(p(50, 100, 1, 2));
  assert.equal(progressShown(n).length, 0);
  m.finish([out("a.md")]);
  const r = await done;
  assert.deepEqual(r, [out("a.md")]);
  assert.equal(n.shown().notes.length, 1);
});

test("ADR 0078 I7: a failed copy command still ends with a result notification and no progress toast", async () => {
  const c = fakeClock();
  const n = createNotifications(c.clock);
  const done = copyWithProgress({ clock: c.clock, notify: n.notify, key: "copy-1", target: "novel", run: () => Promise.reject(new Error("Aleph の扱う範囲の外です")) });
  c.advance(PROGRESS_DELAY);
  await done.catch(() => {});
  assert.equal(progressShown(n).length, 0);
  assert.equal(n.shown().notes.at(-1)?.level, "error");
});
