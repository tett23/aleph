// The variants of how the benchmark hands the prompt and the material to the
// model (docs/research/2026-11-18-assistant-prompt-and-context.md). A variant
// is the default "app" (the app's prompt, app/assistant/prompt.ts, as
// docs/adr/0086 asks), "examples" alone (the app's prompt with all five worked
// examples), or app with one or more features joined with "+", such as
// "app+title-rank+md-no-manual". These are experiments of the benchmark; the
// app is not changed by them.
import { rankSections, terms, type Section } from "../../../app/assistant/material.ts";
import {
  EXAMPLES,
  examplesFor as appExamplesFor,
  exampleTurns,
  INSTRUCTION,
  INTRO,
  isCommandExample,
  REWRITE_RULES,
  userMessage,
  withMaterial,
  type Command,
  type Example,
  type Message,
} from "../../../app/assistant/prompt.ts";
import type { Answer } from "./judge.ts";

export const DEFAULT_VARIANT = "app";
// the name of the variant with all five worked examples; it takes no feature
export const ALL_EXAMPLES_VARIANT = "examples";

export const FEATURES = [
  // the material in the last user message, before the request, instead of the system message
  "user-material",
  // rank the sections by the words of the request found in their titles first
  "title-rank",
  // no section of the Golem manual for a Markdown file
  "md-no-manual",
  // first decide command or rewrite, then ask a prompt made for that one
  "two-step",
  // let the model think before it answers
  "thinking",
] as const;
// "all-examples" is not joined by name: the variant "examples" stands for it
export type Feature = (typeof FEATURES)[number] | "all-examples";

export const parseVariant = (name: string): Feature[] => {
  if (name === DEFAULT_VARIANT) return [];
  if (name === ALL_EXAMPLES_VARIANT) return ["all-examples"];
  const [head, ...parts] = name.split("+");
  const bad = parts.filter((p) => !(FEATURES as readonly string[]).includes(p));
  if (head !== DEFAULT_VARIANT || parts.length === 0 || bad.length > 0)
    throw new Error(`unknown variant: ${name} (${DEFAULT_VARIANT}, ${ALL_EXAMPLES_VARIANT}, or ${DEFAULT_VARIANT} and one or more of ${FEATURES.join(", ")} joined with +)`);
  if (new Set(parts).size !== parts.length) throw new Error(`a feature is repeated: ${name}`);
  return parts as Feature[];
};

// --- the tokens for thinking ---------------------------------------------------

export const THINKING_TOKENS = 1024;

// The tokens kept for the answer besides the 1,024 of ADR 0081: the thinking
export const extraAnswerTokens = (fs: readonly Feature[]) => (fs.includes("thinking") ? THINKING_TOKENS : 0);

// The arguments added to llama-server's: lib/server.ts turns reasoning off, as
// ADR 0081 asks; thinking turns it on again within a budget of tokens
export const serverExtra = (fs: readonly Feature[]): string[] => (fs.includes("thinking") ? ["--reasoning", "on", "--reasoning-budget", String(THINKING_TOKENS)] : []);

// --- worked examples -------------------------------------------------------------

const base = (path: string) => path.slice(path.lastIndexOf("/") + 1).toLowerCase();

// The app's examples for the target, or all five for the variant "examples"
export const examplesFor = (file: string, fs: readonly Feature[]): Example[] => (fs.includes("all-examples") ? [...EXAMPLES] : appExamplesFor(file));

// --- the sections of the manual ------------------------------------------------

// The words of a request: the runs of kanji and katakana, and the identifiers,
// outside 「」 (a quoted text is a word of the target, not of the manual)
export const requestWords = (request: string): string[] => [
  ...new Set(request.replace(/「[^」]*」/g, " ").match(/[\p{Script=Han}\p{Script=Katakana}ー]+|[A-Za-z][A-Za-z0-9_-]*/gu) ?? []),
];

// How much of a title the words cover: a short title that is the word scores
// higher than a long title that has it among others
export const titleScore = (title: string, words: readonly string[]) =>
  title === "" ? 0 : words.filter((w) => title.includes(w)).reduce((n, w) => n + w.length, 0) / [...title].length;

// The sections whose titles have words of the request first, by titleScore;
// then by the overlap of ADR 0081 (rankSections), keeping its order on ties
export const rankByTitle = (sections: readonly Section[], request: string, target: string): Section[] => {
  const words = requestWords(request);
  const byOverlap = rankSections(sections, terms(request, target));
  return byOverlap
    .map((s, i) => ({ s, i, t: titleScore(s.title, words) }))
    .sort((a, b) => b.t - a.t || a.i - b.i)
    .map((x) => x.s);
};

export const rankedSections = (file: string, sections: readonly Section[], request: string, target: string, fs: readonly Feature[]): Section[] => {
  if (fs.includes("md-no-manual") && base(file).endsWith(".md")) return [];
  return fs.includes("title-rank") ? rankByTitle(sections, request, target) : rankSections(sections, terms(request, target));
};

// --- one call ------------------------------------------------------------------

// The messages of one call. With no feature, they are the app's messages().
export const singleMessages = (fs: readonly Feature[], material: string, request: string, file: string, target: string): Message[] => {
  const inUser = fs.includes("user-material");
  const last = userMessage(request, file, target);
  return [
    { role: "system", content: inUser ? INSTRUCTION : withMaterial(INSTRUCTION, material) },
    ...exampleTurns(examplesFor(file, fs), (e) => JSON.stringify(e.answer)),
    { role: "user", content: inUser && material !== "" ? `# 資料\n\n${material}\n\n${last}` : last },
  ];
};

// --- two steps -------------------------------------------------------------------

export const CLASSIFY_INSTRUCTION = `${INTRO}

いまは、書き換えの案を作りません。
頼みが次のどちらかだけを決め、kind に書きます。

- 下の「Aleph のコマンド」に、頼みをそのまま行うコマンドがあるとき (画面を出す、組む、変換する、保存する、捨てる、並べる、記録する、作る、開くなど) は、command です。
- そうでないときは、対象のテキストを書き換えるので、rewrite です。`;

export const CLASSIFY_SCHEMA = {
  type: "object",
  properties: { kind: { type: "string", enum: ["command", "rewrite"] } },
  required: ["kind"],
  additionalProperties: false,
} as const;

export const COMMAND_INSTRUCTION = `${INTRO}

いまの頼みは、Aleph のコマンドで行うものです。
下の「Aleph のコマンド」から、頼みをそのまま行うコマンドを一つ選び、その ID を command に書きます。`;

export const commandSchema = (commands: readonly Command[]) => ({
  type: "object",
  properties: { command: { type: "string", enum: commands.map((c) => c.id) } },
  required: ["command"],
  additionalProperties: false,
});

// The command an example of a command names in its explanation
export const exampleCommand = (e: Example, commands: readonly Command[]) => commands.find((c) => e.answer.explanation.includes(c.id))?.id ?? "";

export const classifyMessages = (commandList: string, request: string, file: string, target: string, fs: readonly Feature[]): Message[] => [
  { role: "system", content: `${CLASSIFY_INSTRUCTION}\n\n${commandList}` },
  ...exampleTurns(examplesFor(file, fs), (e) => JSON.stringify({ kind: isCommandExample(e) ? "command" : "rewrite" })),
  { role: "user", content: userMessage(request, file, target) },
];

export const commandMessages = (commandList: string, commands: readonly Command[], request: string, file: string, target: string, fs: readonly Feature[]): Message[] => [
  { role: "system", content: `${COMMAND_INSTRUCTION}\n\n${commandList}` },
  ...exampleTurns(examplesFor(file, fs).filter(isCommandExample), (e) => JSON.stringify({ command: exampleCommand(e, commands) })),
  { role: "user", content: userMessage(request, file, target) },
];

export const REWRITE_INSTRUCTION = `${INTRO}\n\n${REWRITE_RULES}`;

export const rewriteMessages = (fs: readonly Feature[], material: string, request: string, file: string, target: string): Message[] => {
  const inUser = fs.includes("user-material");
  const last = userMessage(request, file, target);
  return [
    { role: "system", content: inUser ? REWRITE_INSTRUCTION : withMaterial(REWRITE_INSTRUCTION, material) },
    ...exampleTurns(
      examplesFor(file, fs).filter((e) => !isCommandExample(e)),
      (e) => JSON.stringify(e.answer),
    ),
    { role: "user", content: inUser && material !== "" ? `# 資料\n\n${material}\n\n${last}` : last },
  ];
};

// The answer of the form of ADR 0081 for a command chosen in the second step,
// in the words of the worked example of a command
export const commandAnswer = (c: Command): Answer => ({ explanation: `コマンド「${c.label}」(${c.id}) を使います。`, edits: [] });

// The kind of the first step's answer; a broken answer counts as rewrite
export const parseKind = (raw: string): "command" | "rewrite" => {
  try {
    return (JSON.parse(raw) as { kind?: unknown }).kind === "command" ? "command" : "rewrite";
  } catch {
    return "rewrite";
  }
};

export const parseCommand = (raw: string, commands: readonly Command[]): Command | null => {
  try {
    const id = (JSON.parse(raw) as { command?: unknown }).command;
    return commands.find((c) => c.id === id) ?? null;
  } catch {
    return null;
  }
};
