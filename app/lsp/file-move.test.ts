import assert from "node:assert/strict";
import { test } from "node:test";
import { planMoveEdits, type MoveResponse } from "./file-move.ts";

const first = "file:///w/a/manifest.toml";
const second = "file:///w/b/manifest.toml";
const loose = "file:///w/readme.md";

test("ADR 0100 I5: apply both LSP groups as opaque text edits, preserving chapter structure and attributes", () => {
  const sources = [
    'chapters = ["keep.gm", [{file = "notes/a.gm", paragraph-separator = "blank-line"}]]\n',
    'chapters = ["first.gm", "second.gm"]\n',
    '[[a/notes/a.gm|label]]\n',
  ];
  const results = [
    'chapters = ["keep.gm"]\n',
    'chapters = ["first.gm", "second.gm", [{file = "incoming/notes/a.gm", paragraph-separator = "blank-line"}]]\n',
    '[[b/incoming/notes/a.gm|label]]\n',
  ];
  const docs = [first, second, loose].map((uri, i) => ({ uri, text: sources[i], version: i === 2 ? 8 : null }));
  const response: MoveResponse = {
    complete: true,
    groups: docs.map((textDocument, i) => ({
      projectUri: i < 2 ? `file:///w/${i === 0 ? "a" : "b"}` : null,
      edits: [{
        textDocument: { uri: textDocument.uri, version: textDocument.version },
        edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } }, newText: results[i] }],
      }],
    })),
    snapshot: {
      documents: docs, wikiSheets: [{ uri: loose, title: null }], directories: [],
      projects: ["a", "b"].map((p) => ({ uri: `file:///w/${p}`, plotCsv: null })),
    },
    chapters: [{ oldUri: "file:///w/a/notes/a.gm", newUri: "file:///w/b/incoming/notes/a.gm", sourceProjectUri: "file:///w/a", destinationProjectUri: "file:///w/b", sourceIndices: [1, 0] }],
  };
  assert.deepEqual(planMoveEdits("/w", response).map((edit) => edit.after), results);
  assert.throws(() => planMoveEdits("/w", { ...response, complete: false }), /complete/i);
  const stale = { ...response, snapshot: { ...response.snapshot, documents: docs.slice(0, 2) } };
  assert.throws(() => planMoveEdits("/w", stale), /readme/);
});
