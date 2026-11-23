import { test } from "node:test";
import assert from "node:assert/strict";
import { api, type TreeMoveWritePlan } from "./api.ts";
import type { Ctx } from "./ctx.ts";
import type { MoveResponse } from "./lsp/file-move.ts";
import { uriOf } from "./lsp/protocol.ts";
import type { NotifyOpts } from "./notify.ts";
import { answered, consumed, followBatch, independent, unlocked, type Move, type OutsideDeps, type PlanClient } from "./outside-move.ts";
import { allDocs, createStore, initialState, type Doc } from "./store.ts";

const doc = (path: string, text: string, saved = text): Doc => ({
  path, kind: path.split(".").pop()!, text, saved, project: "/w/p", workspace: "/w",
  grid: { chars: 40, lines: 16, vertical: false },
});

type World = {
  ctx: Ctx;
  notices: NotifyOpts[];
  order: string[];
  writes: TreeMoveWritePlan[];
  requests: { moves: { oldUri: string; newUri: string }[] }[];
  deps: OutsideDeps;
  disk: Map<string, string>;
  stops: () => number;
};

/** A workspace /w with the project /w/p, the disk as given, and a Golem LSP that rewrites `img/a.png` to `sub/a.png`. */
const world = (docs: Doc[], files: Record<string, string>, opts: { supported?: boolean; writeError?: string; changeDiskOnPlan?: boolean } = {}): World => {
  const disk = new Map(Object.entries(files));
  const store = createStore({ ...initialState(), workspaces: ["/w"], workspace: "/w" });
  if (docs.length) store.dispatch({ type: "open", docs });
  const notices: NotifyOpts[] = [];
  const order: string[] = [];
  const writes: TreeMoveWritePlan[] = [];
  const requests: World["requests"] = [];
  let stops = 0;
  const ctx = {
    store, projects: ["/w/p"], editors: new Map(), onRename: [], config: { golemPath: "/golem" },
    notify: (o: NotifyOpts) => { notices.push(o); order.push(`notify:${o.message.split("\n")[0]}`); return { id: 0, dismiss() {}, update() {} }; },
    toast: (m: string) => order.push(`toast:${m}`),
    refresh() {},
    renamedOutside: async (moves: Move[]) => void order.push(`renamed:${moves.map((m) => m.to).join(",")}`),
  } as unknown as Ctx;
  api.exists = async (p: string) => disk.has(p);
  api.readText = async (p: string) => disk.get(p) ?? "";
  api.treeMoveRead = async (_w: string, p: string) => disk.get(p) ?? null;
  api.treeMoveInventory = async () => ({ projects: ["/w/p"], entries: [] });
  api.treeMoveWrite = async (plan: TreeMoveWritePlan) => {
    writes.push(plan);
    order.push(`write:${plan.writes.map((w) => w.path).join(",")}`);
    if (opts.writeError && plan.writes.some((w) => !w.path.endsWith("notes.json"))) return { moved: false, error: opts.writeError, remainingWrites: [] };
    for (const w of plan.writes) disk.set(w.path, w.after);
    return { moved: false, error: null, remainingWrites: [] };
  };
  const client = (): PlanClient => ({
    ready: Promise.resolve(true),
    supportsMovedReferences: () => opts.supported ?? true,
    stop: () => void stops++,
    request: async <T,>(_m: string, req: unknown): Promise<T> => {
      const r = req as { moves: { oldUri: string; newUri: string }[]; documents: { uri: string; text: string; version: number }[]; projects: unknown[]; wikiSheets: unknown[] };
      requests.push(r);
      order.push(`plan:${r.moves.length}`);
      const referrers = [...disk].filter(([p, t]) => p.endsWith(".gm") && t.includes("img/"));
      const documents = [...r.documents, ...referrers.filter(([p]) => !r.documents.some((d) => d.uri === uriOf(p))).map(([p, t]) => ({ uri: uriOf(p), text: t, version: null }))];
      const groups = referrers.length ? [{ projectUri: uriOf("/w/p"), edits: referrers.map(([p]) => {
        const d = documents.find((x) => x.uri === uriOf(p))!;
        return { textDocument: { uri: d.uri, version: d.version }, edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: d.text.length } }, newText: d.text.replaceAll("img/", "sub/") }] };
      }) }] : [];
      if (opts.changeDiskOnPlan) for (const [p, t] of referrers) disk.set(p, t + "!");
      const response: MoveResponse = { complete: true, groups, snapshot: { projects: r.projects as MoveResponse["snapshot"]["projects"], wikiSheets: r.wikiSheets as MoveResponse["snapshot"]["wikiSheets"], documents, directories: [] }, chapters: [] };
      return response as T;
    },
  });
  const deps: OutsideDeps = { client, freezeMeta: async () => () => {}, forgetMeta() {}, clearStopped: (p) => void order.push(`clear:${p}`) };
  return { ctx, notices, order, writes, requests, deps, disk, stops: () => stops };
};

const press = async (w: World, label: string) => {
  const note = [...w.notices].reverse().find((n) => n.actions?.some((a) => a.label === label));
  assert.ok(note, `a notice with ${label}`);
  note.actions!.find((a) => a.label === label)!.run();
  await answered();
};

test("ADR 0108 I2: a move that touches a path Aleph's own move holds is dropped", () => {
  const moves = [{ from: "/w/a.gm", to: "/w/b.gm" }, { from: "/w/c.gm", to: "/w/d/c.gm" }];
  assert.deepEqual(unlocked(moves, (p) => p.startsWith("/w/d")), [moves[0]]);
  assert.deepEqual(unlocked(moves, (p) => p === "/w/a.gm"), [moves[1]]);
  assert.deepEqual(unlocked(moves), moves);
});

test("ADR 0108 I3: a batch without moves changes nothing and every path is still followed", async () => {
  const w = world([doc("/w/p/ch.gm", "x")], { "/w/p/ch.gm": "x" });
  const before = w.ctx.store.get();
  const done = await followBatch(w.ctx, w.deps, []);
  assert.deepEqual(done.moves, []);
  assert.equal(w.ctx.store.get(), before);
  assert.deepEqual(w.order, []);
  assert.equal(consumed([], "/w/p/ch.gm"), false);
  assert.equal(consumed([{ from: "/w/p/img", to: "/w/p/sub" }], "/w/p/img/a.png"), true);
  assert.equal(consumed([{ from: "/w/p/img", to: "/w/p/sub" }], "/w/p/imgs/a.png"), false);
});

test("ADR 0108 I4: an open sheet whose moved file has its saved text follows with its edits, without a stop", async () => {
  const w = world([doc("/w/p/ch.gm", "本文と編集", "本文")], { "/w/p/sub/ch.gm": "本文" });
  const done = await followBatch(w.ctx, w.deps, [{ from: "/w/p/ch.gm", to: "/w/p/sub/ch.gm" }]);
  assert.deepEqual(done.kept, []);
  const d = allDocs(w.ctx.store.get());
  assert.deepEqual(d.map((x) => [x.path, x.text, x.saved]), [["/w/p/sub/ch.gm", "本文と編集", "本文"]]);
  assert.ok(w.order.includes("clear:/w/p/ch.gm"));
  assert.ok(!w.notices.some((n) => n.message.includes("ディスクにありません")));
});

test("ADR 0108 I3, I4: a sheet whose moved file also changed keeps its tab and is followed as a change; the rest still follows", async () => {
  const w = world([doc("/w/p/d/a.gm", "a"), doc("/w/p/d/b.gm", "b")], { "/w/p/e/a.gm": "a", "/w/p/e/b.gm": "外で変えた" });
  const done = await followBatch(w.ctx, w.deps, [{ from: "/w/p/d", to: "/w/p/e" }]);
  assert.deepEqual(done.kept, ["/w/p/d/b.gm"]);
  assert.deepEqual(allDocs(w.ctx.store.get()).map((x) => x.path).sort(), ["/w/p/d/b.gm", "/w/p/e/a.gm"]);
  assert.ok(!w.order.includes("clear:/w/p/d/b.gm"));
  assert.ok(w.order.includes("renamed:/w/p/e"));
});

test("ADR 0108 I5, I7: the references change only after 更新する, and the connection heard the move before the question", async () => {
  const files = { "/w/p/sub/a.png": "png", "/w/p/ch.gm": "![](img/a.png)" };
  const no = world([], files);
  const done = await followBatch(no.ctx, no.deps, [{ from: "/w/p/img/a.png", to: "/w/p/sub/a.png" }]);
  await done.offers;
  assert.equal(no.writes.length, 0);
  assert.equal(no.disk.get("/w/p/ch.gm"), "![](img/a.png)");
  assert.equal(no.order.filter((o) => o.startsWith("renamed:")).length, 1);
  assert.ok(no.order.indexOf("renamed:/w/p/sub/a.png") < no.order.findIndex((o) => o.startsWith("notify:")));
  assert.match(no.notices.at(-1)!.message, /^\/w\/p\/img\/a\.png を \/w\/p\/sub\/a\.png に移したことを検出しました。1 件のファイルの参照を新しい場所に更新しますか。$/);
  assert.equal(no.notices.at(-1)!.sticky, true);
  await press(no, "更新しない");
  assert.equal(no.disk.get("/w/p/ch.gm"), "![](img/a.png)");

  const yes = world([], files);
  await (await followBatch(yes.ctx, yes.deps, [{ from: "/w/p/img/a.png", to: "/w/p/sub/a.png" }])).offers;
  await press(yes, "更新する");
  assert.equal(yes.disk.get("/w/p/ch.gm"), "![](sub/a.png)");
  assert.equal(yes.order.filter((o) => o.startsWith("renamed:")).length, 1);
  assert.ok(yes.stops() >= 1, "the planning connection is stopped");
});

test("ADR 0108 I6: a failed write puts back the edits of the open sheets and says what is left", async () => {
  const w = world([doc("/w/p/open.gm", "![](img/a.png)")], { "/w/p/sub/a.png": "png", "/w/p/open.gm": "![](img/a.png)", "/w/p/closed.gm": "![](img/a.png)" }, { writeError: "書けません：/w/p/closed.gm" });
  let text = "![](img/a.png)";
  const identity = {};
  w.ctx.editors.set("/w/p/open.gm", {
    text: () => text,
    edit: {
      core: { text: () => text, doc: () => identity },
      view: { composing: () => false },
      apply: (changes: { from: number; to: number; insert: string }[]) => {
        for (const c of [...changes].sort((a, b) => b.from - a.from)) text = text.slice(0, c.from) + c.insert + text.slice(c.to);
      },
    },
  } as never);
  await (await followBatch(w.ctx, w.deps, [{ from: "/w/p/img/a.png", to: "/w/p/sub/a.png" }])).offers;
  await press(w, "更新する");
  assert.equal(text, "![](img/a.png)");
  assert.equal(w.disk.get("/w/p/closed.gm"), "![](img/a.png)");
  assert.match(w.notices.at(-1)!.message, /^参照を更新できませんでした\n書けません：\/w\/p\/closed\.gm/);
});

test("ADR 0108 I8, I9: the link and metadata listeners leave the references and the notes to the plans", async () => {
  const notes = JSON.stringify({ "ch.gm": { note: "メモ", goal: 10 } });
  const w = world([], { "/w/p/sub/ch.gm": "本文", "/w/p/.aleph/notes.json": notes });
  const seen: [boolean | undefined, boolean | undefined][] = [];
  w.ctx.onRename.push((_f, _t, c) => void seen.push([c.renameReferencesHandled, c.moveMetadataHandled]));
  await followBatch(w.ctx, w.deps, [{ from: "/w/p/ch.gm", to: "/w/p/sub/ch.gm" }]);
  assert.deepEqual(seen, [[true, true]]);
  assert.equal(w.ctx.renameReferencesHandled, undefined);
  assert.equal(w.ctx.moveMetadataHandled, false);
  const meta = w.writes.find((p) => p.writes.some((x) => x.path === "/w/p/.aleph/notes.json"));
  assert.ok(meta);
  assert.deepEqual(JSON.parse(meta.writes[0].after), { "sub/ch.gm": { note: "メモ", goal: 10 } });

  // a note already at the new path: none move, and the writer is told
  const clash = JSON.stringify({ "ch.gm": { note: "a" }, "sub/ch.gm": { note: "b" } });
  const c = world([], { "/w/p/sub/ch.gm": "本文", "/w/p/.aleph/notes.json": clash });
  await followBatch(c.ctx, c.deps, [{ from: "/w/p/ch.gm", to: "/w/p/sub/ch.gm" }]);
  assert.equal(c.writes.length, 0);
  assert.equal(c.disk.get("/w/p/.aleph/notes.json"), clash);
  assert.ok(c.notices.some((n) => n.message.startsWith("移したシートのノートと目標を移せませんでした")));
});

test("ADR 0108 I10: independent moves of a batch are one request and one notice; a chain or a nesting sends none", async () => {
  const w = world([], { "/w/p/sub/a.png": "1", "/w/p/sub/b.png": "2", "/w/p/ch.gm": "![](img/a.png)![](img/b.png)" });
  const two = [{ from: "/w/p/img/a.png", to: "/w/p/sub/a.png" }, { from: "/w/p/img/b.png", to: "/w/p/sub/b.png" }];
  await (await followBatch(w.ctx, w.deps, two)).offers;
  assert.equal(w.requests.length, 1);
  assert.equal(w.requests[0].moves.length, 2);
  assert.equal(w.notices.filter((n) => n.actions?.length).length, 1);
  assert.match(w.notices.at(-1)!.message, /^2 件の移動を検出しました。1 件のファイルの参照を新しい場所に更新しますか。$/);

  assert.equal(independent(two), true);
  const chain = [{ from: "/w/a", to: "/w/b" }, { from: "/w/b", to: "/w/c" }];
  const nest = [{ from: "/w/d", to: "/w/e" }, { from: "/w/d/x.gm", to: "/w/x.gm" }];
  assert.equal(independent(chain), false);
  assert.equal(independent(nest), false);
  const c = world([], { "/w/c": "", "/w/e": "" });
  await (await followBatch(c.ctx, c.deps, chain)).offers;
  assert.equal(c.requests.length, 0);
  assert.ok(c.notices.some((n) => n.message === "2 件の移動は、参照を更新できない組み合わせです"));
});

test("ADR 0108 I5: a Golem LSP without the contract is told once per workspace and Golem, and nothing changes", async () => {
  const files = { "/w/p/sub/a.png": "png", "/w/p/ch.gm": "![](img/a.png)" };
  const w = world([], files, { supported: false });
  w.ctx.config.golemPath = "/golem-old";
  await (await followBatch(w.ctx, w.deps, [{ from: "/w/p/img/a.png", to: "/w/p/sub/a.png" }])).offers;
  await (await followBatch(w.ctx, w.deps, [{ from: "/w/p/sub/a.png", to: "/w/p/img/a.png" }])).offers;
  assert.equal(w.notices.filter((n) => n.message === "Golem LSP が移動後の参照の更新に対応していません").length, 1);
  assert.equal(w.writes.length, 0);
  assert.equal(w.order.filter((o) => o.startsWith("renamed:")).length, 2);
});

test("ADR 0108 I5: a plan that keeps going stale is given up after three tries, with nothing written", async () => {
  const w = world([], { "/w/p/sub/a.png": "png", "/w/p/ch.gm": "![](img/a.png)" }, { changeDiskOnPlan: true });
  await (await followBatch(w.ctx, w.deps, [{ from: "/w/p/img/a.png", to: "/w/p/sub/a.png" }])).offers;
  // the disk is checked by the write; make it refuse as stale every time
  api.treeMoveWrite = async () => { throw new Error("/w/p/ch.gm: 計画取得後に本文が変わりました"); };
  await press(w, "更新する");
  assert.ok(w.notices.some((n) => n.message === "参照の更新の対象が変わり続けたため、更新できませんでした"));
});
