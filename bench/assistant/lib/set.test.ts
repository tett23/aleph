// The task set, the model list and the sources of the benchmark keep the shape
// docs/adr/0081 asks for, and stay in step with the app.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { applyEdits } from "../../../app/assistant/edits.ts";
import { chapterFor } from "../../../app/assistant/material.ts";
import { KINDS, loadTasks } from "./tasks.ts";
import { gpuLines, offloaded, serverArgs } from "./server.ts";

const here = join(import.meta.dirname, "..");
const root = join(here, "..", "..");
const tasks = loadTasks(join(here, "tasks"));
const commands = JSON.parse(readFileSync(join(here, "commands.json"), "utf8")) as { id: string; label: string }[];
const models = (JSON.parse(readFileSync(join(here, "models.json"), "utf8")) as { models: Record<string, unknown>[] }).models;
const sources = JSON.parse(readFileSync(join(here, "sources.json"), "utf8")) as {
  llamaCpp: { tag: string; sha256: string };
  manual: { tag: string; chapters: Record<string, string> };
  contexts: number[];
  budget: { model: string; context: number };
};

test("ADR 0081: ten or more tasks of each of the five kinds, at least one essential", () => {
  for (const kind of KINDS) {
    const of = tasks.filter((t) => t.kind === kind);
    assert.ok(of.length >= 10, `${kind}: ${of.length}`);
    assert.ok(of.some((t) => t.essential), kind);
  }
});

test("the ids of the tasks are unique", () => {
  assert.equal(new Set(tasks.map((t) => t.id)).size, tasks.length);
});

test("a rewrite task has expected texts that differ from its target; a question has a known command and no expected text", () => {
  const ids = new Set(commands.map((c) => c.id));
  for (const t of tasks) {
    if (t.kind === "command") {
      assert.ok(t.command !== null && ids.has(t.command), t.id);
      assert.deepEqual(t.expected, [], t.id);
    } else {
      assert.equal(t.command, null, t.id);
      assert.ok(t.expected.length > 0, t.id);
      for (const e of t.expected) assert.notEqual(e, t.target, t.id);
      assert.ok(t.request.trim() !== "", t.id);
    }
  }
});

test("every task's target picks a chapter of the manual", () => {
  for (const t of tasks) assert.notEqual(chapterFor(t.file), null, t.id);
});

test("a rewrite of each task can reach its expected text with one edit (the task is solvable under I1)", () => {
  for (const t of tasks.filter((x) => x.kind !== "command")) {
    const e = t.expected[0];
    const a = t.target;
    const shorter = Math.min(a.length, e.length);
    const prefix = [...Array(shorter).keys()].find((i) => a[i] !== e[i]) ?? shorter;
    const suffix = [...Array(shorter - prefix).keys()].find((i) => a[a.length - 1 - i] !== e[e.length - 1 - i]) ?? shorter - prefix;
    // the changed part with a few characters of context on each side
    const from = Math.max(0, prefix - 8);
    const keep = Math.max(0, suffix - 8);
    const find = a.slice(from, a.length - keep);
    const replace = e.slice(from, e.length - keep);
    const r = applyEdits(t.target, [{ find, replace }]);
    assert.ok(r.ok && r.text === e, t.id);
  }
});

// every source file of the app, without the tests
const sourcesOf = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return sourcesOf(p);
    return p.endsWith(".ts") && !p.endsWith(".test.ts") ? [readFileSync(p, "utf8")] : [];
  });
const app = sourcesOf(join(root, "app")).join("\n");

test("every command of the list is still a command of the app", () => {
  for (const { id } of commands) {
    const dot = id.lastIndexOf(".");
    const literal = app.includes(`"${id}"`);
    const templated = app.includes(`\`${id.slice(0, dot)}.\${`) && app.includes(`"${id.slice(dot + 1)}"`);
    assert.ok(literal || templated, id);
  }
});

test("ADR 0081: the model list has the four candidates, pinned, with the fields the app will need", () => {
  assert.deepEqual(
    models.map((m) => m.name),
    ["Qwen3-0.6B", "Qwen3.5-0.8B", "Qwen3.5-2B", "Qwen3.5-4B"],
  );
  for (const m of models) {
    assert.match(String(m.repo), /^unsloth\/.+-GGUF$/);
    assert.match(String(m.revision), /^[0-9a-f]{40}$/);
    assert.match(String(m.file), /-Q4_K_M\.gguf$/);
    assert.match(String(m.sha256), /^[0-9a-f]{64}$/);
    assert.ok(Number.isInteger(m.size) && (m.size as number) > 0);
    assert.equal(m.license, "Apache-2.0");
    assert.equal(typeof m.default, "boolean");
  }
  assert.ok(models.some((m) => m.id === sources.budget.model));
});

test("the manual is taken from the tag of the bundled golem (tools.versions)", () => {
  const golem = readFileSync(join(root, "tools.versions"), "utf8")
    .split("\n")
    .find((l) => l.startsWith("golem "));
  assert.equal(golem?.split(/\s+/)[1], sources.manual.tag);
  assert.deepEqual(Object.keys(sources.manual.chapters).sort(), ["03-markup", "04-manifest", "05-style"]);
  assert.deepEqual(sources.contexts, [4096, 8192]);
});

test("the benchmark starts llama-server on a UNIX socket only, with no port (as I5 asks of the app)", () => {
  const args = serverArgs({ model: "/m.gguf", socket: "/tmp/x/llama.sock", context: 4096, log: "/tmp/x/log" });
  assert.equal(args[args.indexOf("--host") + 1], "/tmp/x/llama.sock");
  assert.ok(!args.includes("--port"));
  assert.throws(() => serverArgs({ model: "/m.gguf", socket: "127.0.0.1", context: 4096, log: "/l" }));
});

test("the log tells how many layers went to the GPU", () => {
  const log = "load_tensors: offloading output layer to GPU\nload_tensors: offloaded 29/29 layers to GPU\n";
  assert.deepEqual(offloaded(log), { layers: 29, of: 29 });
  assert.equal(offloaded("nothing"), null);
  assert.equal(gpuLines(log).length, 2);
});

test("the worked examples of the prompt are not tasks of the benchmark, and their edits apply", async () => {
  const { EXAMPLES } = await import("./prompt.ts");
  const ids = new Map(commands.map((c) => [c.id, c.label]));
  for (const e of EXAMPLES) {
    assert.ok(!tasks.some((t) => t.request === e.request || (t.target === e.target && t.file === e.file)), e.request);
    if (e.answer.edits.length === 0) {
      const named = [...ids].filter(([id, label]) => e.answer.explanation.includes(id) && e.answer.explanation.includes(label));
      assert.equal(named.length, 1, e.request);
    } else assert.ok(applyEdits(e.target, e.answer.edits).ok, e.request);
  }
});
