// Whether the plot can be opened (docs/adr/0098): the target project, the check of its plot.csv,
// stale results dropped, and the check again right before running.
import { test } from "node:test";
import assert from "node:assert/strict";
import { initialState, reduce, type Action, type Doc, type State } from "../store.ts";
import { createPlotGate, plotReason, plotTarget, probePlot, type PlotIo } from "./availability.ts";

const doc = (path: string, project: string | null): Doc => ({
  path,
  kind: "gm",
  text: "",
  saved: "",
  project,
  workspace: "/w",
  grid: { chars: 38, lines: 16, vertical: false },
});
const run = (actions: Action[], from: State = initialState()) => actions.reduce(reduce, from);

/** A disk whose answers wait until released, in any order. */
const disk = (files: Record<string, string | Error>) => {
  const waiting: { path: string; release: () => void }[] = [];
  let hold = false;
  const later = <T>(path: string, f: () => T): Promise<T> =>
    hold
      ? new Promise<T>((resolve, reject) =>
          waiting.push({
            path,
            release: () => {
              try {
                resolve(f());
              } catch (e) {
                reject(e);
              }
            },
          }),
        )
      : Promise.resolve().then(f);
  const io: PlotIo = {
    exists: (path) => later(path, () => path in files),
    readText: (path) =>
      later(path, () => {
        const v = files[path];
        if (v === undefined) throw new Error("not found");
        if (v instanceof Error) throw v;
        return v;
      }),
  };
  return {
    io,
    files,
    hold: (on: boolean) => void (hold = on),
    waiting,
    release: async (prefix: string) => {
      // the answers for one project, released until none for it waits (exists, then readText)
      for (let k = 0; k < 10; k++) {
        const i = waiting.findIndex((w) => w.path.startsWith(prefix));
        if (i < 0) {
          await new Promise((r) => setTimeout(r, 0));
          if (!waiting.some((w) => w.path.startsWith(prefix))) return;
          continue;
        }
        waiting.splice(i, 1)[0].release();
        await new Promise((r) => setTimeout(r, 0));
      }
    },
  };
};

const settle = () => new Promise((r) => setTimeout(r, 0));

test("ADR 0098 I2: the target follows view.plot's rule (the focused sheet's project, the shown plot, the followed sheet's project)", () => {
  assert.equal(plotTarget(initialState()), null);
  assert.equal(plotTarget(run([{ type: "open", docs: [doc("/w/a.md", null)] }])), null);
  assert.equal(plotTarget(run([{ type: "open", docs: [doc("/w/p/a.gm", "/w/p")] }])), "/w/p");
  assert.equal(plotTarget(run([{ type: "plot", project: "/w/q" }])), "/w/q");
});

test("ADR 0098 I2: probing tells a header-only plot.csv, a missing one and an unreadable one apart", async () => {
  const d = disk({ "/w/p/plot.csv": "scene,file\n", "/w/r/plot.csv": new Error("permission denied") });
  assert.equal(await probePlot("/w/p", d.io), "present");
  assert.equal(await probePlot("/w/q", d.io), "missing");
  assert.equal(await probePlot("/w/r", d.io), "unreadable");
  // exists itself failing is not "missing"
  assert.equal(await probePlot("/w/p", { exists: async () => { throw new Error("io"); }, readText: async () => "" }), "unreadable");
});

test("ADR 0098 I2: the reason for an unreadable plot.csv says it cannot be read, not that there is no plot", () => {
  const unreadable = plotReason({ kind: "unreadable", project: "/w/p" })!;
  assert.match(unreadable, /読み取れません/);
  assert.doesNotMatch(unreadable, /ありません/);
  assert.match(plotReason({ kind: "missing", project: "/w/p" })!, /plot\.csv がありません/);
  assert.ok(plotReason({ kind: "noTarget" }));
  assert.ok(plotReason({ kind: "checking", project: "/w/p" }));
  assert.equal(plotReason({ kind: "present", project: "/w/p" }), null);
});

test("ADR 0098 I2, I3: no project, no file and checking leave the plot disabled", async () => {
  const d = disk({ "/w/p/plot.csv": "scene\n" });
  let s = initialState();
  const gate = createPlotGate(d.io, () => s, () => {});
  // no project
  await gate.check();
  assert.equal(gate.availability(s).kind, "noTarget");
  assert.equal(gate.enabled(s), false);
  assert.equal(await gate.confirm(), null);
  // a project without plot.csv
  s = run([{ type: "open", docs: [doc("/w/q/a.gm", "/w/q")] }]);
  await gate.check();
  assert.equal(gate.availability(s).kind, "missing");
  assert.equal(gate.enabled(s), false);
  // while checking
  s = run([{ type: "open", docs: [doc("/w/p/a.gm", "/w/p")] }]);
  d.hold(true);
  const pending = gate.check();
  await settle();
  assert.equal(gate.availability(s).kind, "checking");
  assert.equal(gate.enabled(s), false);
  // a target never checked is not taken as present either
  const other = run([{ type: "open", docs: [doc("/w/z/a.gm", "/w/z")] }]);
  assert.equal(gate.availability(other).kind, "checking");
  await d.release("/w/p");
  await pending;
  assert.equal(gate.availability(s).kind, "present");
  assert.equal(gate.enabled(s), true);
});

test("ADR 0098 I2: a header-only plot.csv makes the plot enabled", async () => {
  const d = disk({ "/w/p/plot.csv": "scene,file,subplots\n" });
  const s = run([{ type: "open", docs: [doc("/w/p/a.gm", "/w/p")] }]);
  const gate = createPlotGate(d.io, () => s, () => {});
  await gate.check();
  assert.equal(gate.enabled(s), true);
  assert.equal(await gate.confirm(), "/w/p");
});

test("ADR 0098 I2, I3: deleting plot.csv after the check disables the plot and confirm does not let it run", async () => {
  const d = disk({ "/w/p/plot.csv": "scene\nA\n" });
  const s = run([{ type: "open", docs: [doc("/w/p/a.gm", "/w/p")] }]);
  let changes = 0;
  const gate = createPlotGate(d.io, () => s, () => void changes++);
  await gate.check();
  assert.equal(gate.enabled(s), true);
  delete d.files["/w/p/plot.csv"];
  // right before running: checked again
  assert.equal(await gate.confirm(), null);
  assert.equal(gate.availability(s).kind, "missing");
  assert.equal(gate.enabled(s), false);
  assert.ok(changes > 0);
});

test("ADR 0098 I2: a read failure leaves the plot disabled as unreadable", async () => {
  const d = disk({ "/w/p/plot.csv": new Error("EACCES") });
  const s = run([{ type: "open", docs: [doc("/w/p/a.gm", "/w/p")] }]);
  const gate = createPlotGate(d.io, () => s, () => {});
  await gate.check();
  assert.equal(gate.availability(s).kind, "unreadable");
  assert.equal(gate.enabled(s), false);
});

test("ADR 0098 I4: switching projects while checking ignores the old result, in either order of completion", async () => {
  for (const order of [["/w/p", "/w/q"], ["/w/q", "/w/p"]]) {
    const d = disk({ "/w/p/plot.csv": "scene\n" });
    let s = run([{ type: "open", docs: [doc("/w/p/a.gm", "/w/p")] }]);
    const gate = createPlotGate(d.io, () => s, () => {});
    d.hold(true);
    const first = gate.check();
    s = run([{ type: "open", docs: [doc("/w/q/a.gm", "/w/q")] }]);
    const second = gate.check();
    await settle();
    for (const p of order) await d.release(p);
    await Promise.all([first, second]);
    assert.equal(gate.availability(s).kind, "missing", `order ${order.join(" then ")}`);
    assert.equal(gate.enabled(s), false);
  }
});

test("ADR 0098 I4: a later check of the same project wins over an earlier one that completes last", async () => {
  const d = disk({ "/w/p/plot.csv": "scene\n" });
  const s = run([{ type: "open", docs: [doc("/w/p/a.gm", "/w/p")] }]);
  const gate = createPlotGate(d.io, () => s, () => {});
  d.hold(true);
  const first = gate.check();
  await settle();
  // the earlier check's exists is answered "present" later; the file is deleted and checked again
  const early = d.waiting.splice(0);
  delete d.files["/w/p/plot.csv"];
  const second = gate.check();
  await d.release("/w/p");
  await second;
  assert.equal(gate.availability(s).kind, "missing");
  d.files["/w/p/plot.csv"] = "scene\n";
  for (const w of early) w.release();
  await settle();
  await d.release("/w/p");
  await first;
  assert.equal(gate.availability(s).kind, "missing");
});
