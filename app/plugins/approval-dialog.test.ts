import assert from "node:assert/strict";
import { test } from "node:test";
import { createApprovalPrompts, type PluginApprovalPrompt } from "./approval-dialog.ts";

const first: PluginApprovalPrompt = { id: "first", name: "first.js", path: "/docs/a.gm", action: "シートを読む" };
const second: PluginApprovalPrompt = { ...first, id: "second", path: "/docs/b.gm" };

test("ADR 0120 I2: replacing the visible request never answers the old one", async () => {
  let next: PluginApprovalPrompt | null = first;
  const shown: { prompt: PluginApprovalPrompt; answer: (allow: boolean) => Promise<void> }[] = [];
  const removed: string[] = [];
  const answers: [string, boolean][] = [];
  const sync = createApprovalPrompts(
    async () => next,
    async (id, allow) => { answers.push([id, allow]); next = null; },
    (prompt, answer) => {
      shown.push({ prompt, answer });
      return () => { removed.push(prompt.id); };
    },
  );
  await sync();
  await sync();
  assert.deepEqual(shown.map(({ prompt }) => prompt), [first]);
  next = second;
  await sync();
  await shown[0].answer(true);
  await shown[1].answer(false);
  assert.deepEqual(answers, [[second.id, false]]);
  assert.deepEqual(removed, [first.id, second.id]);
});

test("ADR 0120 I2: a delayed read cannot replace the newer visible request", async () => {
  const reads: ((value: PluginApprovalPrompt) => void)[] = [];
  const shown: string[] = [];
  const sync = createApprovalPrompts(
    () => new Promise((resolve) => { reads.push(resolve); }),
    async () => {},
    (prompt) => { shown.push(prompt.id); return () => {}; },
  );
  const old = sync();
  const recent = sync();
  reads[1](second);
  await recent;
  reads[0](first);
  await old;
  assert.deepEqual(shown, [second.id]);
});
