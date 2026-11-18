// The answer's schema is one file, read by Rust (src-tauri/src/llama.rs) and by the benchmark (docs/adr/0081).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ANSWER_SCHEMA } from "../../bench/assistant/lib/judge.ts";

test("ADR 0081: the schema the local connector binds the answer to is the benchmark's", () => {
  const file = JSON.parse(readFileSync(new URL("./answer.schema.json", import.meta.url), "utf8")) as unknown;
  assert.deepEqual(file, ANSWER_SCHEMA);
});
