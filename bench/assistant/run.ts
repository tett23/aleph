// The benchmark of the assistant's local models (docs/adr/0081).
// Usage: see USAGE below. Progress goes to stderr; a --metric run prints the
// value as the last line of stdout (docs/budgets.md).
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { homedir, loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { chapterFor, joinMaterial, materialLimit, selectMaterial, splitSections } from "../../app/assistant/material.ts";
import { ANSWER_SCHEMA, errorsIn, judgeCommand, judgeEdit, judgeGolem, parseAnswer, type Verdict } from "./lib/judge.ts";
import { commandList, type Command, type Message } from "./lib/prompt.ts";
import {
  CLASSIFY_SCHEMA,
  classifyMessages,
  commandAnswer,
  commandMessages,
  commandSchema,
  DEFAULT_VARIANT,
  extraAnswerTokens,
  parseCommand,
  parseKind,
  parseVariant,
  rankedSections,
  rewriteMessages,
  serverExtra,
  singleMessages,
  THINKING_TOKENS,
  type Feature,
} from "./lib/variant.ts";
import { gpuLines, offloaded, serverArgs } from "./lib/server.ts";
import { median, p95 } from "./lib/stats.ts";
import { pickDefault, qualifies, type Summary } from "./lib/summary.ts";
import { isGolem, KINDS, loadTasks, type Task } from "./lib/tasks.ts";

const USAGE = `usage: bench/assistant/run [options]
  --metric first-answer-ms-p95|answer-ms-p95|peak-rss-mb
                        measure the model and context of sources.json "budget",
                        and print the value as the last line of stdout
  --model <id>          a model of models.json (repeatable; all by default)
  --context <n>         a context length (repeatable; 4096 and 8192 by default)
  --out <file>          write the full report as JSON
  --cold-starts <n>     starts of llama-server for the first-answer time (5)
  --only <id,...>       only these tasks
  --variant <name>      how the prompt and the material are handed to the model:
                        examples (the default), or features of
                        lib/variant.ts joined with +
  --validate-tasks      check the expected texts with golem check; no model
  env ALEPH_BENCH_CACHE the cache of llama.cpp, the models, the manual and the
                        Golem project (~/Library/Caches/aleph-bench)`;

type Model = { id: string; name: string; repo: string; revision: string; file: string; size: number; sha256: string; license: string };
type Sources = {
  llamaCpp: { repo: string; tag: string; archive: string; sha256: string };
  manual: { repo: string; tag: string; chapters: Record<string, string> };
  contexts: number[];
  budget: { model: string; context: number };
};

const here = import.meta.dirname;
const root = join(here, "..", "..");
const readJson = <T>(p: string) => JSON.parse(readFileSync(p, "utf8")) as T;
const sources = readJson<Sources>(join(here, "sources.json"));
const models = readJson<{ models: Model[] }>(join(here, "models.json")).models;
const commands = readJson<Command[]>(join(here, "commands.json"));
const cache = process.env.ALEPH_BENCH_CACHE ?? join(homedir(), "Library", "Caches", "aleph-bench");
const log = (s: string) => process.stderr.write(`${s}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- arguments ---------------------------------------------------------------

type Options = { metric: string | null; models: string[]; contexts: number[]; out: string | null; coldStarts: number; only: string[]; validate: boolean; variant: string };

const parseArgs = (argv: string[]): Options => {
  const take = (i: number) => {
    if (i + 1 >= argv.length) throw new Error(`${argv[i]} needs a value`);
    return argv[i + 1];
  };
  const step = (i: number, o: Options): Options => {
    if (i >= argv.length) return o;
    const a = argv[i];
    if (a === "--metric") return step(i + 2, { ...o, metric: take(i) });
    if (a === "--model") return step(i + 2, { ...o, models: [...o.models, take(i)] });
    if (a === "--context") return step(i + 2, { ...o, contexts: [...o.contexts, Number(take(i))] });
    if (a === "--out") return step(i + 2, { ...o, out: take(i) });
    if (a === "--cold-starts") return step(i + 2, { ...o, coldStarts: Number(take(i)) });
    if (a === "--only") return step(i + 2, { ...o, only: take(i).split(",") });
    if (a === "--validate-tasks") return step(i + 1, { ...o, validate: true });
    if (a === "--variant") return step(i + 2, { ...o, variant: take(i) });
    if (a === "--help" || a === "-h") {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    }
    throw new Error(`unknown argument: ${a}\n${USAGE}`);
  };
  return step(0, { metric: null, models: [], contexts: [], out: null, coldStarts: 5, only: [], validate: false, variant: DEFAULT_VARIANT });
};

// --- processes and files ------------------------------------------------------

const run = (cmd: string, args: string[], opts: { cwd?: string } = {}) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) =>
    execFile(cmd, args, { cwd: opts.cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr }),
    ),
  );

const sha256 = (path: string) =>
  new Promise<string>((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path)
      .on("data", (d) => h.update(d))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });

// Fetches a URL to `dest` unless a file with the SHA-256 is there. A download
// whose SHA-256 differs is deleted (as I7 asks of the app).
const fetchVerified = async (url: string, dest: string, sum: string) => {
  if (existsSync(dest) && (await sha256(dest)) === sum) return dest;
  mkdirSync(join(dest, ".."), { recursive: true });
  const part = `${dest}.part`;
  log(`downloading ${url}`);
  const r = await run("/usr/bin/curl", ["-fsSL", "--retry", "3", "-o", part, url]);
  if (r.code !== 0) throw new Error(`download failed: ${url}: ${r.stderr.trim()}`);
  const got = await sha256(part);
  if (got !== sum) {
    rmSync(part, { force: true });
    throw new Error(`SHA-256 mismatch for ${url}: ${got}, expected ${sum}`);
  }
  renameSync(part, dest);
  return dest;
};

const llamaServer = async () => {
  const l = sources.llamaCpp;
  const dir = join(cache, "llama.cpp", l.tag);
  const bin = join(dir, `llama-${l.tag}`, "llama-server");
  const archive = await fetchVerified(`https://github.com/${l.repo}/releases/download/${l.tag}/${l.archive}`, join(dir, l.archive), l.sha256);
  if (!existsSync(bin)) {
    const r = await run("tar", ["-xzf", archive, "-C", dir]);
    if (r.code !== 0 || !existsSync(bin)) throw new Error(`cannot extract ${archive}: ${r.stderr}`);
  }
  return bin;
};

const modelFile = (m: Model) => fetchVerified(`https://huggingface.co/${m.repo}/resolve/${m.revision}/${m.file}`, join(cache, "models", m.file), m.sha256);

const manual = async () => {
  const m = sources.manual;
  const entries = await Promise.all(
    Object.entries(m.chapters).map(async ([name, sum]) => {
      const p = await fetchVerified(`https://raw.githubusercontent.com/${m.repo}/${m.tag}/manual/chapters/${name}.gm`, join(cache, "manual", m.tag, `${name}.gm`), sum);
      return [name, splitSections(readFileSync(p, "utf8"))] as const;
    }),
  );
  return new Map(entries);
};

// --- golem check -------------------------------------------------------------

type Golem = { bin: string; version: string; project: string } | { skipped: string };

const findGolem = async (): Promise<Golem> => {
  const bundled = join(root, "src-tauri", "resources", "golem");
  const bin = existsSync(bundled) ? bundled : (await run("/bin/sh", ["-c", "command -v golem"])).stdout.trim();
  if (bin === "") return { skipped: "golem was found neither in src-tauri/resources nor on PATH; the golem check part is skipped" };
  const version = (await run(bin, ["--version"])).stdout.trim();
  // a project of `golem new` (with its fonts) and two more chapter files
  const project = join(cache, "golem-project", version.replace(/[^\w.-]/g, "_"));
  if (!existsSync(join(project, "manifest.toml"))) {
    const tmp = mkdtempSync(join(tmpdir(), "aleph-bench-new-"));
    const r = await run(bin, ["new", join(tmp, "p")]);
    if (r.code !== 0) return { skipped: `golem new failed: ${r.stderr.trim()}` };
    writeFileSync(join(tmp, "p", "chapters", "02.gm"), "# 第二章\n\n本文。\n");
    writeFileSync(join(tmp, "p", "chapters", "03.gm"), "# 第三章\n\n本文。\n");
    mkdirSync(join(project, ".."), { recursive: true });
    rmSync(project, { recursive: true, force: true });
    renameSync(join(tmp, "p"), project);
  }
  return { bin, version, project };
};

const checkCache = new Map<string, number>();

// The errors of golem check in `file` after replacing it with `text`
const golemErrors = async (g: Golem, file: string, text: string): Promise<number> => {
  if ("skipped" in g) return 0;
  const key = `${file}\0${text}`;
  const hit = checkCache.get(key);
  if (hit !== undefined) return hit;
  const dir = mkdtempSync(join(tmpdir(), "aleph-bench-check-"));
  try {
    cpSync(g.project, dir, { recursive: true });
    writeFileSync(join(dir, file), text);
    const r = await run(g.bin, ["check", "--format", "json"], { cwd: dir });
    // golem 0.1.0-rc4 writes the diagnostics to stderr when there is an error
    const out = r.stdout.trim() !== "" ? r.stdout : r.stderr;
    const diagnostics = (() => {
      try {
        return JSON.parse(out) as unknown;
      } catch {
        throw new Error(`golem check did not print JSON (exit ${r.code}): ${out.slice(0, 300)}`);
      }
    })();
    const n = errorsIn(diagnostics, file);
    checkCache.set(key, n);
    return n;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

// --- llama-server over a UNIX socket -----------------------------------------

// the llama-servers running now, stopped when the benchmark is interrupted
const live = new Set<ChildProcess>();
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => {
    live.forEach((p) => p.kill("SIGTERM"));
    process.exit(130);
  });

type Server = { proc: ChildProcess; socket: string; dir: string; log: string; startedAt: number; tokens: Map<string, number> };

const call = (socket: string, method: string, path: string, body?: unknown, timeoutMs = 600000) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      { socketPath: socket, path, method, headers: data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}, timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("timeout", () => req.destroy(new Error(`timed out: ${path}`)));
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });

const start = async (bin: string, model: string, context: number, extra: string[] = []): Promise<Server> => {
  const dir = mkdtempSync(join(tmpdir(), "aleph-bench-"));
  const socket = join(dir, "llama.sock");
  const logFile = join(dir, "llama-server.log");
  const startedAt = performance.now();
  // -lv 4 makes llama-server log where the layers went
  const proc = spawn(bin, [...serverArgs({ model, socket, context, log: logFile }), ...extra], { stdio: "ignore" });
  live.add(proc);
  proc.once("exit", () => live.delete(proc));
  const s: Server = { proc, socket, dir, log: logFile, startedAt, tokens: new Map() };
  const deadline = Date.now() + 300000;
  const wait = async (): Promise<Server> => {
    if (proc.exitCode !== null) throw new Error(`llama-server exited with ${proc.exitCode}: ${tail(logFile)}`);
    if (Date.now() > deadline) throw new Error("llama-server did not become ready in 300 s");
    const ok = await call(socket, "GET", "/health", undefined, 2000).then((r) => r.status === 200, () => false);
    if (ok) return s;
    await sleep(50);
    return wait();
  };
  return wait();
};

const tail = (p: string) => (existsSync(p) ? readFileSync(p, "utf8").split("\n").slice(-20).join("\n") : "");

const stop = async (s: Server) => {
  if (s.proc.exitCode === null) {
    const exited = new Promise((r) => s.proc.once("exit", r));
    s.proc.kill("SIGTERM");
    await Promise.race([exited, sleep(10000)]);
    if (s.proc.exitCode === null) s.proc.kill("SIGKILL");
  }
};

const count = async (s: Server, text: string) => {
  const hit = s.tokens.get(text);
  if (hit !== undefined) return hit;
  const r = await call(s.socket, "POST", "/tokenize", { content: text, add_special: false, parse_special: false });
  const n = (JSON.parse(r.body) as { tokens: unknown[] }).tokens.length;
  s.tokens.set(text, n);
  return n;
};

// The tokens of the rendered chat with the material left empty: the fixed
// instruction, the request, the target and the chat template
const fixedTokens = async (s: Server, ms: Message[], thinking: boolean) => {
  const r = await call(s.socket, "POST", "/apply-template", { messages: ms, chat_template_kwargs: { enable_thinking: thinking } });
  const prompt = (JSON.parse(r.body) as { prompt: string }).prompt;
  const t = await call(s.socket, "POST", "/tokenize", { content: prompt, add_special: true, parse_special: true });
  return (JSON.parse(t.body) as { tokens: unknown[] }).tokens.length;
};

type Sections = Map<string, { title: string; text: string }[]>;
type Budget = { fixed: number; limit: number; materialTokens: number; sections: number; titles: string[] };

// The messages of a call whose material is the command list (when
// `withCommands`) and the ranked sections, chosen within the budget (I9).
// `build` makes the messages from the material.
const prompt = async (s: Server, context: number, chapters: Sections, t: Task, fs: readonly Feature[], withCommands: boolean, build: (material: string) => Message[]) => {
  const fixed = await fixedTokens(s, build(""), fs.includes("thinking"));
  const limit = Math.max(0, materialLimit(context, fixed) - extraAnswerTokens(fs));
  const chapter = chapterFor(t.file);
  const sections = rankedSections(t.file, chapter ? (chapters.get(chapter) ?? []) : [], t.request, t.target, fs);
  const ranked = sections.map((x) => x.text);
  const items = withCommands ? [commandList(commands), ...ranked] : ranked;
  const costs = new Map<string, number>();
  await Promise.all(items.map(async (x) => costs.set(x, await count(s, `${x}\n\n`))));
  const chosen = items.length === 0 ? [] : selectMaterial(items[0], items.slice(1), limit, (x) => costs.get(x.slice(0, -2)) ?? Infinity);
  const titles = sections.filter((x) => chosen.includes(x.text)).map((x) => x.title);
  const budget: Budget = { fixed, limit, materialTokens: chosen.reduce((n, x) => n + (costs.get(x) ?? 0), 0), sections: titles.length, titles };
  return { messages: build(joinMaterial(chosen)), budget };
};

type AskOptions = { schema: unknown; thinking: boolean };

const ask = async (s: Server, ms: Message[], o: AskOptions) => {
  const t0 = performance.now();
  const r = await call(s.socket, "POST", "/v1/chat/completions", {
    messages: ms,
    temperature: 0,
    seed: 0,
    max_tokens: 1024 + (o.thinking ? THINKING_TOKENS : 0),
    json_schema: o.schema,
    chat_template_kwargs: { enable_thinking: o.thinking },
  });
  const ms_ = performance.now() - t0;
  const body = JSON.parse(r.body) as {
    choices?: { message?: { content?: string; reasoning_content?: string }; finish_reason?: string }[];
    error?: unknown;
    timings?: Record<string, number>;
  };
  const choice = body.choices?.[0];
  const t = body.timings ?? {};
  const timings = { promptTokens: t.prompt_n, cachedTokens: t.cache_n, promptMs: Math.round(t.prompt_ms ?? 0), predictedTokens: t.predicted_n, predictedMs: Math.round(t.predicted_ms ?? 0) };
  return {
    ms: ms_,
    content: choice?.message?.content ?? "",
    reasoning: choice?.message?.reasoning_content ?? "",
    finish: choice?.finish_reason ?? `error ${JSON.stringify(body.error ?? r.status)}`,
    timings,
  };
};

type Step = { kind: "command" | "rewrite"; ms: number; raw?: string };

// The answer to a task under a variant: one call, or two (the kind, then a
// prompt for that kind). The content has the form of ADR 0081 either way.
const respond = async (s: Server, context: number, chapters: Sections, t: Task, fs: readonly Feature[]) => {
  const thinking = fs.includes("thinking");
  if (!fs.includes("two-step")) {
    const p = await prompt(s, context, chapters, t, fs, true, (m) => singleMessages(fs, m, t.request, t.file, t.target));
    const a = await ask(s, p.messages, { schema: ANSWER_SCHEMA, thinking });
    return { ...a, budget: p.budget, step: null as Step | null };
  }
  const list = commandList(commands);
  const k = await ask(s, classifyMessages(list, t.request, t.file, t.target, fs), { schema: CLASSIFY_SCHEMA, thinking });
  const kind = parseKind(k.content);
  if (kind === "command") {
    const ms = commandMessages(list, commands, t.request, t.file, t.target, fs);
    const fixed = await fixedTokens(s, ms, thinking);
    const a = await ask(s, ms, { schema: commandSchema(commands), thinking });
    const c = parseCommand(a.content, commands);
    // the answer of ADR 0081's form, made from the chosen command
    const content = c !== null && a.finish === "stop" ? JSON.stringify(commandAnswer(c)) : a.content;
    const budget: Budget = { fixed, limit: Math.max(0, materialLimit(context, fixed) - extraAnswerTokens(fs)), materialTokens: 0, sections: 0, titles: [] };
    return { ...a, ms: k.ms + a.ms, content, budget, step: { kind, ms: Math.round(k.ms), raw: a.content } as Step | null };
  }
  const p = await prompt(s, context, chapters, t, fs, false, (m) => rewriteMessages(fs, m, t.request, t.file, t.target));
  const a = await ask(s, p.messages, { schema: ANSWER_SCHEMA, thinking });
  return { ...a, ms: k.ms + a.ms, budget: p.budget, step: { kind, ms: Math.round(k.ms) } as Step | null };
};

// --- memory -------------------------------------------------------------------

const rssMb = async (pid: number) => {
  const r = await run("/bin/ps", ["-o", "rss=", "-p", String(pid)]);
  const kb = Number(r.stdout.trim());
  return Number.isFinite(kb) && kb > 0 ? kb / 1024 : 0;
};

// Samples the RSS of the process every 100 ms until stopped; returns the peak
const sampler = (pid: number) => {
  const state = { peak: 0, on: true };
  const loop = async (): Promise<void> => {
    if (!state.on) return;
    state.peak = Math.max(state.peak, await rssMb(pid));
    await sleep(100);
    return loop();
  };
  const done = loop();
  return {
    stop: async () => {
      state.on = false;
      await done;
      return state.peak;
    },
  };
};

// --- one configuration --------------------------------------------------------

type TaskResult = {
  id: string;
  kind: string;
  essential: boolean;
  pass: boolean;
  reason: string;
  ms: number;
  finish: string;
  answer: string;
  timings: Record<string, number | undefined>;
  golem?: { before: number; after: number };
  // the titles of the manual's sections that went in
  sections: string[];
  // the first step of two-step: the kind it chose
  step?: Step;
  reasoning?: string;
};

const judge = async (g: Golem, t: Task, content: string, finish: string): Promise<{ verdict: Verdict; golem?: { before: number; after: number } }> => {
  if (finish !== "stop") return { verdict: { pass: false, reason: `the answer did not finish: ${finish}` } };
  const parsed = parseAnswer(content);
  if (!parsed.ok) return { verdict: { pass: false, reason: parsed.reason } };
  if (t.kind === "command") {
    const label = commands.find((c) => c.id === t.command)?.label ?? "";
    return { verdict: judgeCommand(parsed.answer, t.command ?? "", label) };
  }
  const v = judgeEdit(t.target, parsed.answer, t.expected);
  if (!isGolem(t) || "skipped" in g || v.text === undefined) return { verdict: v };
  const before = await golemErrors(g, t.file, t.target);
  const after = await golemErrors(g, t.file, v.text);
  return { verdict: judgeGolem(v, before, after), golem: { before, after } };
};

const coldTasks = (tasks: Task[], n: number) => {
  const firsts = KINDS.map((k) => tasks.find((t) => t.kind === k)).filter((t): t is Task => t !== undefined);
  const pool = firsts.length > 0 ? firsts : tasks;
  return Array.from({ length: n }, (_, i) => pool[i % pool.length]);
};

const measure = async (bin: string, m: Model, context: number, tasks: Task[], chapters: Sections, g: Golem, coldStarts: number, fs: readonly Feature[]) => {
  const file = await modelFile(m);
  const loadBefore = loadavg();
  log(`== ${m.name} @ ${context} (load average ${loadBefore.map((x) => x.toFixed(1)).join(" ")})`);

  // from the start of llama-server to the first answer
  const cold: number[] = [];
  const coldPeaks: number[] = [];
  for (const t of coldTasks(tasks, coldStarts)) {
    const t0 = performance.now();
    const s = await start(bin, file, context, serverExtra(fs));
    const sample = sampler(s.proc.pid ?? 0);
    try {
      await respond(s, context, chapters, t, fs);
      cold.push(performance.now() - t0);
    } finally {
      coldPeaks.push(await sample.stop());
      await stop(s);
      rmSync(s.dir, { recursive: true, force: true });
    }
    log(`  cold start ${cold.length}: ${Math.round(cold[cold.length - 1])} ms`);
  }

  // every task on one llama-server, after it started
  const s = await start(bin, file, context, serverExtra(fs));
  const sample = sampler(s.proc.pid ?? 0);
  const results: TaskResult[] = [];
  const budget: Budget[] = [];
  try {
    for (const t of tasks) {
      const a = await respond(s, context, chapters, t, fs);
      budget.push(a.budget);
      const j = await judge(g, t, a.content, a.finish);
      results.push({
        id: t.id,
        kind: t.kind,
        essential: t.essential,
        pass: j.verdict.pass,
        reason: j.verdict.reason,
        ms: Math.round(a.ms),
        finish: a.finish,
        answer: a.content,
        timings: a.timings,
        ...(j.golem ? { golem: j.golem } : {}),
        sections: a.budget.titles,
        ...(a.step ? { step: a.step } : {}),
        ...(a.reasoning !== "" ? { reasoning: a.reasoning } : {}),
      });
      log(`  ${j.verdict.pass ? "pass" : "FAIL"} ${t.id}${a.step ? ` [${a.step.kind}]` : ""} ${Math.round(a.ms)} ms (prompt ${a.timings.promptTokens} tokens ${a.timings.promptMs} ms, answer ${a.timings.predictedTokens} tokens ${a.timings.predictedMs} ms) ${j.verdict.reason}`);
    }
  } catch (e) {
    await sample.stop();
    await stop(s);
    throw e;
  }
  const peakWarm = await sample.stop();
  // the memory while it waits for the next request
  await sleep(5000);
  const idle = await rssMb(s.proc.pid ?? 0);
  await stop(s);
  rmSync(s.dir, { recursive: true, force: true });

  // where the layers went: llama-server logs it at -lv 4, which slows the
  // answers, so a start of its own that is not timed
  const probe = await start(bin, file, context, [...serverExtra(fs), "-lv", "4"]);
  await stop(probe);
  const serverLog = existsSync(probe.log) ? readFileSync(probe.log, "utf8") : "";
  rmSync(probe.dir, { recursive: true, force: true });

  const byKind = Object.fromEntries(
    KINDS.filter((k) => results.some((r) => r.kind === k)).map((k) => {
      const of = results.filter((r) => r.kind === k);
      return [k, of.filter((r) => r.pass).length / of.length];
    }),
  );
  const answerMs = results.map((r) => r.ms);
  const summary: Summary = {
    key: `${m.id}@${context}`,
    model: m.id,
    context,
    firstAnswerMsP95: Math.round(p95(cold)),
    answerMsMedian: Math.round(median(answerMs)),
    answerMsP95: Math.round(p95(answerMs)),
    peakRssMb: Math.round(Math.max(peakWarm, ...coldPeaks)),
    successRate: results.filter((r) => r.pass).length / results.length,
    successByKind: byKind,
    essentialFailed: results.filter((r) => r.essential && !r.pass).map((r) => r.id),
  };
  return {
    summary,
    model: { id: m.id, name: m.name, repo: m.repo, revision: m.revision, file: m.file, sha256: m.sha256 },
    context,
    firstAnswerMs: { all: cold.map(Math.round), median: Math.round(median(cold)), p95: Math.round(p95(cold)) },
    answerMs: { median: Math.round(median(answerMs)), p95: Math.round(p95(answerMs)) },
    peakRssMb: summary.peakRssMb,
    idleRssMb: Math.round(idle),
    gpu: { offloaded: offloaded(serverLog), lines: gpuLines(serverLog) },
    material: {
      fixedTokensMax: Math.max(...budget.map((b) => b.fixed)),
      limitMin: Math.min(...budget.map((b) => b.limit)),
      sectionsMedian: median(budget.map((b) => b.sections)),
      materialTokensMedian: median(budget.map((b) => b.materialTokens)),
    },
    essential: { passed: results.filter((r) => r.essential && r.pass).map((r) => r.id), failed: summary.essentialFailed },
    // other work on the machine slows the answers; kept with the numbers
    loadAverage: { before: loadBefore, after: loadavg() },
    tasks: results,
  };
};

// --- the modes ------------------------------------------------------------------

const machine = async () => {
  const sys = async (k: string) => (await run("/usr/sbin/sysctl", ["-n", k])).stdout.trim();
  return { model: await sys("hw.model"), memBytes: Number(await sys("hw.memsize")), cpu: await sys("machdep.cpu.brand_string"), os: (await run("/usr/bin/sw_vers", ["-productVersion"])).stdout.trim() };
};

const validate = async (tasks: Task[]) => {
  const g = await findGolem();
  if ("skipped" in g) throw new Error(g.skipped);
  log(`golem ${g.version}`);
  const bad = (
    await Promise.all(
      tasks.filter(isGolem).flatMap((t) =>
        t.expected.map(async (e, i) => {
          const before = await golemErrors(g, t.file, t.target);
          const after = await golemErrors(g, t.file, e);
          log(`${after <= before ? "ok  " : "BAD "} ${t.id}[${i}] errors ${before} -> ${after}`);
          return after <= before ? [] : [`${t.id}[${i}]`];
        }),
      ),
    )
  ).flat();
  if (bad.length > 0) throw new Error(`expected texts that add errors of golem check: ${bad.join(", ")}`);
  log(`${tasks.filter(isGolem).length} Golem tasks: every expected text keeps the errors of golem check`);
};

const metricOf = (s: Summary, metric: string) => {
  if (metric === "first-answer-ms-p95") return s.firstAnswerMsP95;
  if (metric === "answer-ms-p95") return s.answerMsP95;
  if (metric === "peak-rss-mb") return s.peakRssMb;
  throw new Error(`unknown metric: ${metric}`);
};

const table = (runs: Awaited<ReturnType<typeof measure>>[]) =>
  [
    "| モデル | コンテキスト | 起動からの答え 中央値 / p95 (ms) | 答え 中央値 / p95 (ms) | 最大の RSS (MB) | 待ちの RSS (MB) | 正解 | style | manifest | gm | markdown | command | 欠かせない課題 | GPU の層 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...runs.map((r) => {
      const pc = (x: number | undefined) => (x === undefined ? "-" : `${Math.round(x * 100)}%`);
      const k = r.summary.successByKind;
      const ess = `${r.essential.passed.length}/${r.essential.passed.length + r.essential.failed.length}${r.essential.failed.length ? ` (落ちた: ${r.essential.failed.join(", ")})` : ""}`;
      const gpu = r.gpu.offloaded ? `${r.gpu.offloaded.layers}/${r.gpu.offloaded.of}` : "記録なし";
      return `| ${r.model.name} | ${r.context} | ${r.firstAnswerMs.median} / ${r.firstAnswerMs.p95} | ${r.answerMs.median} / ${r.answerMs.p95} | ${r.peakRssMb} | ${r.idleRssMb} | ${pc(r.summary.successRate)} | ${pc(k.style)} | ${pc(k.manifest)} | ${pc(k.gm)} | ${pc(k.markdown)} | ${pc(k.command)} | ${ess} | ${gpu} |`;
    }),
  ].join("\n");

const main = async () => {
  const o = parseArgs(process.argv.slice(2));
  const features = parseVariant(o.variant);
  const all = loadTasks(join(here, "tasks"));
  const tasks = o.only.length > 0 ? all.filter((t) => o.only.includes(t.id)) : all;
  if (tasks.length === 0) throw new Error("no tasks");
  if (o.validate) return validate(tasks);

  const chosen = o.metric ? [sources.budget.model] : o.models.length > 0 ? o.models : models.map((m) => m.id);
  const contexts = o.metric ? [sources.budget.context] : o.contexts.length > 0 ? o.contexts : sources.contexts;
  const unknown = chosen.filter((id) => !models.some((m) => m.id === id));
  if (unknown.length > 0) throw new Error(`unknown model: ${unknown.join(", ")}`);
  if (o.metric) metricOf({ firstAnswerMsP95: 0, answerMsP95: 0, peakRssMb: 0 } as Summary, o.metric);

  const bin = await llamaServer();
  const chapters = await manual();
  const g = await findGolem();
  if ("skipped" in g) log(g.skipped);
  const runs: Awaited<ReturnType<typeof measure>>[] = [];
  for (const id of chosen)
    for (const c of contexts) runs.push(await measure(bin, models.find((m) => m.id === id)!, c, tasks, chapters, g, o.coldStarts, features));

  const report = {
    schema: 1,
    variant: { name: o.variant, features },
    date: new Date().toISOString(),
    commit: (await run("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim(),
    machine: await machine(),
    llamaCpp: sources.llamaCpp,
    manual: sources.manual,
    golemCheck: "skipped" in g ? { skipped: g.skipped } : { bin: g.bin, version: g.version },
    tasks: { count: tasks.length, byKind: Object.fromEntries(KINDS.map((k) => [k, tasks.filter((t) => t.kind === k).length])), essential: tasks.filter((t) => t.essential).map((t) => t.id) },
    coldStarts: o.coldStarts,
    runs,
    summaries: runs.map((r) => r.summary),
    selection: { qualifies: runs.map((r) => qualifies(r.summary)), pick: pickDefault(runs.map((r) => r.summary)) },
  };
  if (o.out) writeFileSync(o.out, `${JSON.stringify(report, null, 2)}\n`);
  log(table(runs));
  log(`the selection rule picks: ${report.selection.pick ?? "none"}`);
  if (o.metric) process.stdout.write(`${metricOf(runs[0].summary, o.metric)}\n`);
  else process.stdout.write(`${table(runs)}\n`);
};

main().catch((e: unknown) => {
  log(`assistant bench: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
