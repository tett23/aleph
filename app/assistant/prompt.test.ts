// The prompt of the local connector (docs/adr/0086): the instruction and the
// material in the system message, the worked examples for the target's kind
// and the one of a command as earlier turns, then the writer's request.
import { test } from "node:test";
import assert from "node:assert/strict";
import { materialLimit } from "./material.ts";
import { EXAMPLES, examplesFor, exampleTurns, fixedTokens, INSTRUCTION, isCommandExample, messages, type Message } from "./prompt.ts";

const files = (file: string) => examplesFor(file).map((e) => e.file);
const commandExample = EXAMPLES.find(isCommandExample)!;

test("ADR 0086 I1: every kind has exactly one example of a command", () => {
  assert.equal(EXAMPLES.filter(isCommandExample).length, 1);
  for (const file of ["style.toml", "manifest.toml", "chapters/01.gm", "notes.md", "data.csv", "other.toml", "LICENSE"]) {
    const of = examplesFor(file);
    assert.equal(of.filter(isCommandExample).length, 1, file);
    assert.equal(of[of.length - 1], commandExample, file);
  }
});

test("ADR 0086 I1: a style.toml target gets the style.toml example and the command example only", () => {
  assert.deepEqual(files("style.toml"), ["style.toml", commandExample.file]);
  assert.deepEqual(files("book/style.toml"), ["style.toml", commandExample.file]);
});

test("ADR 0086 I1: a manifest.toml target gets the manifest.toml example and the command example only", () => {
  assert.deepEqual(files("manifest.toml"), ["manifest.toml", commandExample.file]);
});

test("ADR 0086 I1: a .gm target gets the .gm example and the command example only", () => {
  const of = examplesFor("chapters/01.gm");
  assert.equal(of.length, 2);
  assert.ok(!isCommandExample(of[0]) && of[0].file.endsWith(".gm"));
  assert.equal(of[1], commandExample);
});

test("ADR 0086 I1: a .md target gets the .md example and the command example only", () => {
  assert.deepEqual(files("notes.md"), ["notes.md", commandExample.file]);
});

test("ADR 0086 I1: an upper-case extension (.GM) gets the same examples as .gm", () => {
  assert.deepEqual(examplesFor("chapters/01.GM"), examplesFor("chapters/01.gm"));
  assert.deepEqual(examplesFor("STYLE.TOML"), examplesFor("style.toml"));
});

test("ADR 0086 I1: a .csv target gets the command example only", () => {
  assert.deepEqual(examplesFor("data.csv"), [commandExample]);
});

test("ADR 0086 I1: a .toml target of another name gets the command example only", () => {
  assert.deepEqual(examplesFor("other.toml"), [commandExample]);
});

test("ADR 0086 I1: a target with no extension gets the command example only", () => {
  assert.deepEqual(examplesFor("LICENSE"), [commandExample]);
  assert.deepEqual(examplesFor("chapters/gm"), [commandExample]);
});

const roles = (ms: Message[]) => ms.map((m) => m.role);

test("ADR 0086 I3: with two examples, the messages are system, user, assistant, user, assistant, user", () => {
  const ms = messages("", "頼み", "style.toml", "x = 1\n");
  assert.deepEqual(roles(ms), ["system", "user", "assistant", "user", "assistant", "user"]);
  assert.equal(ms[0].content, INSTRUCTION);
  assert.match(ms[ms.length - 1].content, /^頼み: 頼み\n/);
});

test("ADR 0086 I3: with one example, the messages are system, user, assistant, user", () => {
  const ms = messages("MATERIAL", "頼み", "data.csv", "a,b\n");
  assert.deepEqual(roles(ms), ["system", "user", "assistant", "user"]);
  assert.equal(ms[0].content, `${INSTRUCTION}\n\n# 資料\n\nMATERIAL`);
  assert.equal(JSON.parse(ms[2].content).edits.length, 0);
});

// a chat template for the tests: each message in its role's markers
const render = (ms: readonly Message[]) => ms.map((m) => `<${m.role}>${m.content}</${m.role}>`).join("");
// a token counter for the tests: one token per character
const chars = (s: string) => [...s].length;

test("ADR 0086 I4: the fixed part is the tokens of the rendered messages with the material left empty", async () => {
  const build = (examples: ReturnType<typeof examplesFor>) => (material: string) => messages(material, "頼み", "style.toml", "x = 1\n", examples);
  const two = examplesFor("style.toml");
  assert.equal(two.length, 2);
  const withTwo = await fixedTokens(build(two), render, chars);
  const withNone = await fixedTokens(build([]), render, chars);
  assert.equal(withTwo, chars(render(build(two)(""))));
  assert.equal(withTwo - withNone, chars(render(exampleTurns(two))));
  // the material does not count
  const seen: Message[][] = [];
  await fixedTokens((m) => (seen.push(build(two)(m)), build(two)(m)), render, chars);
  assert.deepEqual(seen, [build(two)("")]);
});

test("ADR 0086 I4: the fixed part takes an asynchronous template and counter (the llama-server calls)", async () => {
  const build = (m: string) => messages(m, "頼み", "notes.md", "本文\n");
  assert.equal(
    await fixedTokens(build, async (ms) => render(ms), async (s) => chars(s)),
    await fixedTokens(build, render, chars),
  );
});

test("ADR 0086 I4: the material limit is 4,096 less the fixed part and 1,024", () => {
  assert.equal(materialLimit(4096, 1000), 2072);
  assert.equal(materialLimit(4096, 3072), 0);
});
