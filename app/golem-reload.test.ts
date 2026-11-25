import assert from "node:assert/strict";
import { test } from "node:test";
import { afterPathChange, reloadGolem, reloadShem, resetEnabled, type ReloadDeps } from "./golem-reload.ts";

/** A fake of the app: project connections by project, the open LSP documents, the .gm editors and the kinsoku values. */
const app = (o: { open?: Record<string, string[]>; gm?: string[]; kept?: string[]; moving?: boolean; found?: boolean; unsaved?: string } = {}) => {
  let serial = 0;
  const open = o.open ?? {};
  const clients = new Map<string, number>(Object.keys(open).map((p) => [p, ++serial]));
  clients.set("/w/closed", ++serial);
  const before = new Set(clients.values());
  const opened: string[] = [];
  const kinsoku: string[] = [];
  const kept = new Set(o.kept ?? []);
  const notices: { message: string; level: string }[] = [];
  const log: string[] = [];
  const docs = { "/w/a/one.gm": o.unsaved ?? "text" };
  const d: ReloadDeps = {
    moving: () => o.moving ?? false,
    info: async (tool) => {
      log.push(`info ${tool}`);
      if (o.found === false) throw new Error(`${tool} が見つかりません`);
      return { version: `${tool} 0.2.0` };
    },
    resetLsp: () => { log.push("reset"); clients.clear(); },
    resync: async () => {
      log.push("resync");
      for (const [project, paths] of Object.entries(open)) {
        clients.set(project, ++serial);
        opened.push(...paths);
      }
    },
    reread: async () => {
      log.push("reread");
      for (const p of o.gm ?? []) kinsoku.push(p);
      for (const p of [...kept]) if (!(o.gm ?? []).includes(p)) kept.delete(p);
    },
    forget: () => log.push("forget"),
    redraw: () => log.push("redraw"),
    notify: (message, level) => notices.push({ message, level }),
  };
  return { d, clients, before, opened, kinsoku, kept, notices, log, docs };
};

test("ADR 0112 I1, I2: a reload leaves no old connection and opens a new one for each project with an open LSP document", async () => {
  const a = app({ open: { "/w/a": ["/w/a/one.gm"], "/w/b": ["/w/b/notes.md"] } });
  await reloadGolem(a.d);
  assert.ok([...a.clients.values()].every((id) => !a.before.has(id)));
  assert.deepEqual([...a.clients.keys()].sort(), ["/w/a", "/w/b"]);
  assert.deepEqual(a.opened, ["/w/a/one.gm", "/w/b/notes.md"]);
  assert.ok(!a.clients.has("/w/closed"));
  assert.deepEqual(a.log, ["reset", "info golem", "resync", "reread", "forget", "redraw"]);
});

test("ADR 0112 I1, I2: with nothing open a reload leaves no connection", async () => {
  const a = app();
  await reloadGolem(a.d);
  assert.equal(a.clients.size, 0);
  assert.equal(a.notices.length, 1);
});

test("ADR 0112 I2, I10: a missing golem leaves no connection and gives one error and no info", async () => {
  const a = app({ open: { "/w/a": ["/w/a/one.gm"] }, found: false });
  await reloadGolem(a.d);
  assert.equal(a.clients.size, 0);
  assert.deepEqual(a.notices.map((n) => n.level), ["error"]);
  assert.match(a.notices[0].message, /golem が見つかりません/);
  assert.ok(!a.log.includes("resync"));
});

test("ADR 0112 I3: a reload does not touch the documents", async () => {
  const a = app({ open: { "/w/a": ["/w/a/one.gm"] }, unsaved: "not saved yet" });
  await reloadGolem(a.d);
  assert.deepEqual(a.docs, { "/w/a/one.gm": "not saved yet" });
});

test("ADR 0112 I4: a reload forgets the unsupported notice", async () => {
  const a = app();
  await reloadGolem(a.d);
  assert.ok(a.log.includes("forget"));
});

test("ADR 0112 I5: a shem reload keeps the project connections", async () => {
  const a = app({ open: { "/w/a": ["/w/a/one.gm"] } });
  await reloadShem(a.d);
  assert.deepEqual([...a.clients.values()].sort(), [...a.before].sort());
  assert.deepEqual(a.log, ["info shem", "redraw"]);
  assert.match(a.notices[0].message, /shem を読み込みなおしました：shem 0\.2\.0/);
});

test("ADR 0112 I6: during a move a golem reload changes nothing and says why", async () => {
  const a = app({ open: { "/w/a": ["/w/a/one.gm"] }, moving: true });
  await reloadGolem(a.d);
  assert.deepEqual([...a.clients.values()].sort(), [...a.before].sort());
  assert.deepEqual(a.log, []);
  assert.match(a.notices[0].message, /移動が終わってから読み込みなおしてください/);
});

test("ADR 0112 I7: the reset button is enabled only for a saved path that is not empty", () => {
  assert.equal(resetEnabled(""), false);
  assert.equal(resetEnabled("   "), false);
  assert.equal(resetEnabled("/usr/local/bin/golem"), true);
});

test("ADR 0112 I6, I8: a path change reloads its row once, not when refused, and not golem during a move", async () => {
  const cases: [string, "golem" | "shem", boolean, boolean, string[]][] = [
    ["golem written", "golem", true, false, ["reset", "info golem", "resync", "reread", "forget", "redraw"]],
    ["shem written", "shem", true, false, ["info shem", "redraw"]],
    ["golem refused", "golem", false, false, ["redraw"]],
    ["shem refused", "shem", false, false, ["redraw"]],
  ];
  for (const [name, tool, changed, moving, log] of cases) {
    const a = app({ moving });
    await afterPathChange(tool, changed, a.d);
    assert.deepEqual(a.log, log, name);
  }
});

test("ADR 0112 I9: kinsoku is read once per project with a .gm editor, and the other values are dropped", async () => {
  const a = app({ open: { "/w/a": ["/w/a/one.gm"], "/w/b": ["/w/b/notes.md"] }, gm: ["/w/a"], kept: ["/w/a", "/w/b"] });
  await reloadGolem(a.d);
  assert.deepEqual(a.kinsoku, ["/w/a"]);
  assert.deepEqual([...a.kept], ["/w/a"]);
});

test("ADR 0112 I10: a reload ends with one info notice with the version", async () => {
  const a = app({ open: { "/w/a": ["/w/a/one.gm"] } });
  await reloadGolem(a.d);
  assert.deepEqual(a.notices, [{ message: "Golem を読み込みなおしました：golem 0.2.0", level: "info" }]);
});
