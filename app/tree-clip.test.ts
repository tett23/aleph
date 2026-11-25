import assert from "node:assert/strict";
import { test } from "node:test";
import { createClip, type ClipDeps } from "./tree-clip.ts";

type Board = { count: number; files: number };

const deps = (o: { board: Board; exists?: boolean; moved?: boolean }) => {
  const calls: string[] = [];
  const notices: string[] = [];
  const d: ClipDeps = {
    board: async () => { calls.push("board"); return { ...o.board }; },
    exists: async (path) => { calls.push(`exists ${path}`); return o.exists ?? true; },
    move: async (from, dir) => { calls.push(`move ${from} ${dir}`); return o.moved ?? true; },
    copy: async (dir) => { calls.push(`copy ${dir}`); },
    notify: (message) => { notices.push(message); },
  };
  return { d, calls, notices };
};

test("ADR 0109 I1: cutting asks only for the pasteboard and changes nothing on disk", async () => {
  const clip = createClip();
  const { d, calls } = deps({ board: { count: 3, files: 0 } });
  await clip.cut("/w/a.gm", d);
  assert.deepEqual(calls, ["board"]);
  assert.deepEqual(clip.current(), { path: "/w/a.gm", count: 3 });
});

test("ADR 0109 I2: there is at most one cut, and cancel, copy and a workspace switch clear it", async () => {
  const clip = createClip();
  const { d } = deps({ board: { count: 1, files: 0 } });
  await clip.cut("/w/a.gm", d);
  await clip.cut("/w/b.gm", d);
  assert.equal(clip.current()?.path, "/w/b.gm");
  for (const clear of [() => clip.cancel(), () => clip.copied(), () => clip.switched()]) {
    await clip.cut("/w/a.gm", d);
    clear();
    assert.equal(clip.current(), null);
  }
});

const cases: { name: string; cut: boolean; board: Board; exists?: boolean; calls: string[]; notice: RegExp | null; left: boolean; numbers: string }[] = [
  { name: "no cut and no file URLs", cut: false, board: { count: 5, files: 0 }, calls: ["board"], notice: /貼り付けるものがありません/, left: false, numbers: "I3" },
  { name: "no cut and one file URL", cut: false, board: { count: 5, files: 1 }, calls: ["board", "copy /w/d"], notice: null, left: false, numbers: "I3" },
  { name: "a cut, the same count, no file URLs", cut: true, board: { count: 5, files: 0 }, calls: ["board", "exists /w/a.gm", "move /w/a.gm /w/d"], notice: null, left: false, numbers: "I3" },
  { name: "a cut, the same count, file URLs", cut: true, board: { count: 5, files: 2 }, calls: ["board", "exists /w/a.gm", "move /w/a.gm /w/d"], notice: null, left: false, numbers: "I3" },
  { name: "a cut, the count one up, file URLs", cut: true, board: { count: 6, files: 1 }, calls: ["board", "copy /w/d"], notice: null, left: false, numbers: "I3, I4" },
  { name: "a cut, the count one up, no file URLs", cut: true, board: { count: 6, files: 0 }, calls: ["board"], notice: /貼り付けるものがありません/, left: false, numbers: "I3, I4" },
  { name: "a cut gone from disk, the same count, file URLs", cut: true, board: { count: 5, files: 1 }, exists: false, calls: ["board", "exists /w/a.gm"], notice: /\/w\/a\.gm が見つかりません/, left: false, numbers: "I3, I7" },
];

for (const c of cases) {
  test(`ADR 0109 ${c.numbers}: pasting with ${c.name}`, async () => {
    const clip = createClip();
    if (c.cut) await clip.cut("/w/a.gm", deps({ board: { count: 5, files: 0 } }).d);
    const { d, calls, notices } = deps({ board: c.board, exists: c.exists });
    await clip.paste("/w/d", d);
    assert.deepEqual(calls, c.calls);
    if (c.notice) assert.match(notices.join("\n"), c.notice);
    else assert.deepEqual(notices, []);
    assert.equal(clip.current() !== null, c.left);
  });
}

test("ADR 0109 I5: the cut stays when the move does not end on disk, and goes when it does", async () => {
  for (const moved of [false, true]) {
    const clip = createClip();
    const { d } = deps({ board: { count: 5, files: 0 }, moved });
    await clip.cut("/w/a.gm", d);
    await clip.paste("/w/d", d);
    assert.equal(clip.current() !== null, !moved);
  }
});

test("ADR 0109 I2: the clip tells its listeners when the cut changes", async () => {
  const clip = createClip();
  let told = 0;
  clip.listen(() => { told++; });
  const { d } = deps({ board: { count: 1, files: 0 } });
  await clip.cut("/w/a.gm", d);
  clip.cancel();
  clip.cancel();
  assert.equal(told, 2);
});
