// The variants of how the benchmark hands the prompt and the material to the
// model (lib/variant.ts)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { judgeCommand, parseAnswer } from "./judge.ts";
import { commandList, EXAMPLES, INSTRUCTION, messages, userMessage, type Command } from "./prompt.ts";
import {
  classifyMessages,
  commandAnswer,
  commandMessages,
  commandSchema,
  examplesFor,
  exampleCommand,
  extraAnswerTokens,
  parseCommand,
  parseKind,
  parseVariant,
  rankByTitle,
  rankedSections,
  requestWords,
  rewriteMessages,
  serverExtra,
  singleMessages,
  THINKING_TOKENS,
  titleScore,
} from "./variant.ts";

const commands = JSON.parse(readFileSync(join(import.meta.dirname, "..", "commands.json"), "utf8")) as Command[];
const list = commandList(commands);

test("a variant is the default or features joined with +", () => {
  assert.deepEqual(parseVariant("examples"), []);
  assert.deepEqual(parseVariant("title-rank+md-no-manual"), ["title-rank", "md-no-manual"]);
  assert.throws(() => parseVariant(""));
  assert.throws(() => parseVariant("nothing"));
  assert.throws(() => parseVariant("title-rank+nothing"));
  assert.throws(() => parseVariant("thinking+thinking"));
});

test("with no feature, the messages of one call are the default prompt's", () => {
  for (const material of ["", "## 資料の節\n\n本文。\n\n"])
    assert.deepEqual(singleMessages([], material, "頼み", "chapters/01.gm", "本文。\n"), messages(material, "頼み", "chapters/01.gm", "本文。\n"));
});

test("user-material puts the material before the request in the last user message", () => {
  const ms = singleMessages(["user-material"], "MATERIAL\n\n", "頼み", "a.gm", "本文。\n");
  assert.equal(ms[0].content, INSTRUCTION);
  const last = ms[ms.length - 1];
  assert.equal(last.role, "user");
  assert.ok(last.content.startsWith("# 資料\n\nMATERIAL\n\n"));
  assert.ok(last.content.endsWith(userMessage("頼み", "a.gm", "本文。\n")));
  // no material: nothing is added
  assert.deepEqual(singleMessages(["user-material"], "", "頼み", "a.gm", "本文。\n"), messages("", "頼み", "a.gm", "本文。\n"));
});

test("kind-examples keeps the examples of the target's kind and the one of a command", () => {
  const files = (file: string) => examplesFor(file, ["kind-examples"]).map((e) => e.file);
  assert.deepEqual(files("style.toml"), ["style.toml", "chapters/03.gm"]);
  assert.deepEqual(files("manifest.toml"), ["manifest.toml", "chapters/03.gm"]);
  assert.deepEqual(files("notes.md"), ["notes.md", "chapters/03.gm"]);
  assert.deepEqual(files("chapters/01.gm"), ["chapters/03.gm", "chapters/03.gm"]);
  assert.equal(examplesFor("style.toml", []).length, EXAMPLES.length);
});

test("the words of a request leave out the quoted words", () => {
  assert.deepEqual(requestWords("「東京」に「とうきょう」とルビを振って"), ["ルビ", "振"]);
  assert.deepEqual(requestWords("「大切」を強調して"), ["強調"]);
  assert.deepEqual(requestWords("chapters/02.gm を足して"), ["chapters", "gm", "足"]);
});

test("titleScore is the share of the title the words cover", () => {
  assert.equal(titleScore("注", ["注"]), 1);
  assert.equal(titleScore("", ["注"]), 0);
  assert.equal(titleScore("強調と圏点", ["強調"]), 2 / 5);
  assert.ok(titleScore("行番号、キャプション、注釈の印", ["注"]) < titleScore("注", ["注"]));
});

test("rankByTitle puts the sections whose titles have the words first, then keeps the overlap order", () => {
  const sections = [
    { title: "数と式", text: "## 数と式\n強調して書く式。強調。" },
    { title: "強調と圏点", text: "## 強調と圏点\n[strong: 語]" },
    { title: "注", text: "## 注\n強調" },
  ];
  assert.deepEqual(
    rankByTitle(sections, "「大切」を強調して", "これは大切なことです。\n").map((s) => s.title),
    ["強調と圏点", "数と式", "注"],
  );
});

test("md-no-manual gives no section for a Markdown file only; title-rank changes the order", () => {
  const sections = [
    { title: "数と式", text: "## 数と式\n強調" },
    { title: "強調と圏点", text: "## 強調と圏点\n強調" },
  ];
  assert.deepEqual(rankedSections("notes.md", sections, "強調して", "x\n", ["md-no-manual"]), []);
  assert.equal(rankedSections("a.gm", sections, "強調して", "x\n", ["md-no-manual"]).length, 2);
  assert.equal(rankedSections("a.gm", sections, "強調して", "x\n", [])[0].title, "数と式");
  assert.equal(rankedSections("a.gm", sections, "強調して", "x\n", ["title-rank"])[0].title, "強調と圏点");
});

test("two-step: the first step's examples answer the kind; the command step's examples answer a listed command", () => {
  const k = classifyMessages(list, "頼み", "chapters/01.gm", "本文。\n", []);
  assert.ok(k[0].content.endsWith(list));
  const kinds = k.filter((m) => m.role === "assistant").map((m) => JSON.parse(m.content).kind);
  assert.deepEqual(kinds, EXAMPLES.map((e) => (e.answer.edits.length === 0 ? "command" : "rewrite")));

  const c = commandMessages(list, commands, "頼み", "chapters/01.gm", "本文。\n", []);
  const answers = c.filter((m) => m.role === "assistant").map((m) => JSON.parse(m.content).command);
  assert.ok(answers.length > 0);
  for (const id of answers) assert.ok(commandSchema(commands).properties.command.enum.includes(id), id);
  for (const e of EXAMPLES.filter((x) => x.answer.edits.length === 0)) assert.notEqual(exampleCommand(e, commands), "");
});

test("two-step: the rewrite step has no command list and no example of a command", () => {
  const r = rewriteMessages([], "MATERIAL\n\n", "頼み", "a.gm", "本文。\n");
  assert.ok(!r[0].content.includes("Aleph のコマンド"));
  assert.ok(r[0].content.endsWith("# 資料\n\nMATERIAL\n\n"));
  for (const m of r.filter((x) => x.role === "assistant")) assert.ok(JSON.parse(m.content).edits.length > 0);
});

test("the answer made from a chosen command passes the command judge", () => {
  const c = commands.find((x) => x.id === "project.build")!;
  const parsed = parseAnswer(JSON.stringify(commandAnswer(c)));
  assert.ok(parsed.ok);
  if (parsed.ok) assert.deepEqual(judgeCommand(parsed.answer, c.id, c.label), { pass: true, reason: "" });
});

test("a broken first step counts as rewrite; a broken command step chooses nothing", () => {
  assert.equal(parseKind('{"kind":"command"}'), "command");
  assert.equal(parseKind('{"kind":"rewrite"}'), "rewrite");
  assert.equal(parseKind("{"), "rewrite");
  assert.equal(parseCommand('{"command":"project.build"}', commands)?.id, "project.build");
  assert.equal(parseCommand('{"command":"no.such"}', commands), null);
  assert.equal(parseCommand("", commands), null);
});

test("thinking keeps tokens for the thoughts and turns reasoning on in llama-server", () => {
  assert.equal(extraAnswerTokens([]), 0);
  assert.deepEqual(serverExtra([]), []);
  assert.equal(extraAnswerTokens(["thinking"]), THINKING_TOKENS);
  assert.deepEqual(serverExtra(["thinking"]), ["--reasoning", "on", "--reasoning-budget", String(THINKING_TOKENS)]);
});
