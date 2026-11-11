import assert from "node:assert/strict";
import test from "node:test";
import { bindEditorDoc } from "./binding.ts";
import type { Doc } from "../store.ts";

test("ADR 0070 invariant 4: the mounted editor saves edits through its renamed document", () => {
  const initial = { path: "/w/book/draft/a.md", project: "/w/book", text: "draft" } as Doc;
  const binding = bindEditorDoc(initial);
  const saved = new Map<string, string>();
  const save = (text: string) => saved.set(binding.doc.path, text);
  binding.update({ ...initial, path: "/w/novel/draft/a.md", project: "/w/novel" });
  save("continued");
  assert.deepEqual([...saved], [["/w/novel/draft/a.md", "continued"]]);
  assert.equal(binding.doc.project, "/w/novel");
  assert.equal(initial.project, "/w/book");
});
