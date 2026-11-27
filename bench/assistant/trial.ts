// Compare the two production Rust inference paths using the same task prompts.
// Usage: node bench/assistant/trial.ts [report.json]
// ALEPH_TRIAL_ONLY restricts the task IDs; ALEPH_TRIAL_BASELINE reuses raw baseline rows.
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { chapterFor, rankSections, splitSections, terms } from "../../app/assistant/material.ts";
import { commandList, messages, type Command } from "../../app/assistant/prompt.ts";
import { errorsIn, judgeEdit, judgeGolem, parseAnswer } from "./lib/judge.ts";
import { isGolem, loadTasks, type Task } from "./lib/tasks.ts";

type Case = Pick<Task, "id" | "file" | "request" | "target" | "expected"> & {
  kind: Task["kind"] | "emet" | "reference";
  workspace?: string;
  expectedFact?: string;
  expectedFacts?: string[];
  expectedReference?: string;
};
type Row = { id: string; answer?: string; references?: string[]; manualFull?: boolean; context?: number; ms: number; error?: string };
const here = import.meta.dirname;
const root = resolve(here, "../..");
const resources = join(root, "src-tauri/resources");
const golem = join(resources, "golem");
const scratch = mkdtempSync(join(tmpdir(), "aleph-trial-"));
const commands = JSON.parse(readFileSync(join(here, "commands.json"), "utf8")) as Command[];
const bundled = (chapter: string) => readFileSync(join(resources, "manual", `${chapter}.gm`), "utf8");

const emetCases: Case[] = [
  { id: "emet-add-one", kind: "emet", file: "functions/count.emet", request: "count に 1 を足して返してください。", target: "pub fn nextCount :: Nat -> Nat\nnextCount count = count\n", expected: ["pub fn nextCount :: Nat -> Nat\nnextCount count = count + 1\n"] },
  { id: "emet-string-suffix", kind: "emet", file: "functions/text.emet", request: "title の末尾に文字列「氏」を足して返してください。", target: "pub fn displayTitle :: String -> String\ndisplayTitle title = title\n", expected: ["pub fn displayTitle :: String -> String\ndisplayTitle title = title ++ \"氏\"\n"] },
];

const fixture = (name: string, caseInfo: Omit<Case, "kind" | "workspace" | "expected">, extra: [string, string]): Case => {
  const workspace = join(scratch, name);
  mkdirSync(join(workspace, "chapters"), { recursive: true });
  mkdirSync(join(workspace, "functions"));
  writeFileSync(join(workspace, "manifest.toml"), 'chapters = ["chapters/01.gm"]\n');
  writeFileSync(join(workspace, caseInfo.file), caseInfo.target);
  const path = join(workspace, extra[0]);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, extra[1]);
  return { ...caseInfo, kind: "reference", workspace, expected: [], expectedReference: extra[0] };
};

type ReferenceFixture = { id: string; path: string; request: string; source: string; facts: string[] };
const newReferenceFixtures = JSON.parse(readFileSync(join(here, "reference-cases.json"), "utf8")) as ReferenceFixture[];
const normalizeFact = (text: string) => text.normalize("NFKC").replace(/\s+/g, "");
const benchmark = () => {
  const allCases: Case[] = [
    ...loadTasks(join(here, "tasks")).filter(isGolem),
    ...emetCases,
    ...newReferenceFixtures.map(({ id, path, request, source, facts }) => fixture(id, {
      id, file: "chapters/01.gm", request: request + "原稿は編集しないでください。",
      target: "# 第一章\n\n本文。\n", expectedFacts: facts,
    }, [path, source])),
    fixture("reference-emet", {
      id: "emet-closed-definition", file: "chapters/01.gm",
      request: "functions/price.emet を読み、関数の戻り値の数を答えてください。原稿は編集しないでください。",
      target: "@import functions/price.emet as price\n\n# 価格\n\n本文。\n", expectedFact: "57136",
    }, ["functions/price.emet", "pub fn basePrice :: Nat\nbasePrice = 57136\n"]),
    fixture("reference-chapter", {
      id: "gm-closed-chapter", file: "chapters/01.gm",
      request: "同じプロジェクトの chapters/02.gm を読み、登場人物の名前を答えてください。原稿は編集しないでください。",
      target: "# 第一章\n\n人物を紹介します。\n", expectedFact: "星螺みずか",
    }, ["chapters/02.gm", "# 第二章\n\n主人公は星螺みずかです。\n"]),
  ];
  const only = process.env.ALEPH_TRIAL_ONLY?.split(",");
  const cases = only ? allCases.filter((task) => only.includes(task.id)) : allCases;
  if (only && cases.length !== only.length) throw new Error("unknown or duplicate trial case");
  const input = join(scratch, "input.json");
  writeFileSync(input, JSON.stringify(cases.map(({ id, file, request, target, workspace }) => {
    const label = chapterFor(file);
    const selected = label ? rankSections(splitSections(bundled(label)), terms(request, target)).map((item) => item.text) : [];
    return { id, file, workspace, messages: messages("", request, file, target), sections: [commandList(commands), ...selected] };
  })));

  const checkProject = join(scratch, "check-base");
  execFileSync(golem, ["new", checkProject], { stdio: "ignore" });
  writeFileSync(join(checkProject, "chapters/02.gm"), "# 第二章\n\n本文。\n");
  writeFileSync(join(checkProject, "chapters/03.gm"), "# 第三章\n\n本文。\n");
  const check = (file: string, text: string, emet: boolean) => {
    const dir = mkdtempSync(join(scratch, "check-"));
    try {
      cpSync(checkProject, dir, { recursive: true });
      if (emet) {
        mkdirSync(join(dir, "functions"), { recursive: true });
        writeFileSync(join(dir, "chapters/01.gm"), `@import ${file} as test\n\n# 関数\n\n本文。\n`);
      }
      writeFileSync(join(dir, file), text);
      const out = spawnSync(golem, ["check", "--format", "json"], { cwd: dir, encoding: "utf8" });
      return errorsIn(JSON.parse(out.stdout.trim() || out.stderr), file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const score = (task: Case, row: Row) => {
    const parsed = parseAnswer(row.answer ?? "");
    if (!parsed.ok) return { ...row, kind: task.kind, pass: false, reason: row.error ?? parsed.reason };
    if (task.expectedFacts) {
      const verifiedReference = row.references?.some((value) => value.startsWith(task.expectedReference + ":")) ?? false;
      const explanation = normalizeFact(parsed.answer.explanation);
      const missingFacts = task.expectedFacts.filter((fact) => !explanation.includes(normalizeFact(fact)));
      const pass = verifiedReference && parsed.answer.edits.length === 0 && missingFacts.length === 0;
      return { ...row, kind: task.kind, pass, verifiedReference, missingFacts };
    }
    if (task.expectedFact) {
      const pass = parsed.answer.edits.length === 0 && parsed.answer.explanation.includes(task.expectedFact);
      return { ...row, kind: task.kind, pass, verifiedReference: row.references?.some((value) => value.includes(task.expectedReference!)) ?? false };
    }
    const verdict = judgeEdit(task.target, parsed.answer, task.expected);
    if (verdict.text === undefined) return { ...row, kind: task.kind, ...verdict };
    const before = check(task.file, task.target, task.kind === "emet");
    const after = check(task.file, verdict.text, task.kind === "emet");
    const { pass, reason } = judgeGolem(verdict, before, after);
    return { ...row, kind: task.kind, pass, reason, before, after };
  };
  const modes = (process.env.ALEPH_TRIAL_MODES ?? "baseline,preload").split(",");
  return modes.map((mode) => {
    if (mode !== "baseline" && mode !== "preload") throw new Error(`unknown trial mode: ${mode}`);
    const existing = mode === "baseline" ? process.env.ALEPH_TRIAL_BASELINE : undefined;
    const output = existing ?? join(scratch, `${mode}.jsonl`);
    if (!existing) execFileSync("cargo", ["test", "--manifest-path", "src-tauri/Cargo.toml", "--locked", "--offline", "--lib", "assistant_trial::measure_local_assistant_trial", "--", "--exact", "--ignored", "--nocapture"], {
      cwd: root, stdio: "inherit", env: { ...process.env, ALEPH_TRIAL_MODE: mode, ALEPH_TRIAL_INPUT: input, ALEPH_TRIAL_OUTPUT: output },
    });
    const rows = readFileSync(output, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Row)
      .filter((row) => cases.some((task) => task.id === row.id));
    if (rows.length !== cases.length) throw new Error(`expected ${cases.length} rows, got ${rows.length}`);
    const results = rows.map((row, index) => {
      if (row.id !== cases[index].id) throw new Error(`unexpected trial case: ${row.id}`);
      return score(cases[index], row);
    });
    return { mode, passed: results.filter((row) => row.pass).length, total: results.length, results };
  });
};

try {
  const report = JSON.stringify(benchmark(), null, 2) + "\n";
  if (process.argv[2]) writeFileSync(process.argv[2], report);
  else process.stdout.write(report);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
