import assert from "node:assert/strict";
import test from "node:test";
import { createdPath, SHEET_KINDS } from "./tree-create.ts";

test("ADR 0065 invariant 1: project and nested folder each receive one chosen sheet of every kind", () => {
  const kinds = ["gm", "md", "emet", "txt", "toml", "csv", "tsv", "svg", "mmd", "json", "jsonc", "json5", "jsonl"] as const;
  assert.deepEqual(SHEET_KINDS, kinds);
  for (const parent of ["/w/book", "/w/book/draft"]) {
    for (const kind of kinds) {
      assert.equal(createdPath(parent, "opening", kind), `${parent}/opening.${kind}`);
      assert.equal(createdPath(parent, `opening.${kind}`, kind), `${parent}/opening.${kind}`);
    }
    assert.equal(createdPath(parent, "images", null), `${parent}/images`);
  }
});

test("ADR 0065 invariant 2: empty and path-like names cannot make entries", () => {
  for (const name of ["", " ", ".", "..", "one/two", "one\\two"]) {
    assert.equal(createdPath("/w/book", name, "gm"), null);
    assert.equal(createdPath("/w/book", name, null), null);
  }
});
