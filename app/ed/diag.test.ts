import { test } from "node:test";
import assert from "node:assert/strict";
import { allSources, clampDiagnostics, diagLines, withSource, type Diag } from "./diag.ts";
import { textOf } from "./text.ts";

const doc = textOf("霧笛\n灯台\n");

test("each line's mark is its most severe diagnostic", () => {
  const m = diagLines(doc, [
    { from: 0, to: 1, severity: "warning", message: "" },
    { from: 1, to: 2, severity: "error", message: "" },
    { from: 3, to: 4, severity: "hint", message: "" },
    { from: 4, to: 5, severity: "info", message: "" },
  ]);
  assert.deepEqual([...m], [
    [1, "error"],
    [2, "info"],
  ]);
});

test("diagnostics are kept inside the text, and one at a point underlines the next character", () => {
  const out = clampDiagnostics(doc, [
    { from: 1, to: 1, severity: "error", message: "a" },
    { from: 2, to: 2, severity: "error", message: "end of line" },
    { from: 4, to: 99, severity: "warning", message: "b" },
    { from: 99, to: 99, severity: "info", message: "c" },
  ]);
  assert.deepEqual(
    out.map((d) => [d.from, d.to, d.cls]),
    [
      [1, 2, "ed-diag diag-error"],
      [2, 2, "ed-diag diag-error"],
      [4, 6, "ed-diag diag-warning"],
      [6, 6, "ed-diag diag-info"],
    ],
  );
  assert.equal(out[0].message, "a");
});

test("diagnostics from several sources lie together; each source replaces only its own (docs/adr/0030)", () => {
  const d = (from: number, source: string): Diag => ({ from, to: from + 1, severity: "info", message: source, source });
  let by = withSource(new Map(), "lsp", [d(0, "lsp")]);
  by = withSource(by, "proofread", [d(2, "punctuation"), d(4, "raNuki")]);
  assert.deepEqual(allSources(by).map((x) => x.from), [0, 2, 4]);
  by = withSource(by, "proofread", [d(5, "fullwidth")]);
  assert.deepEqual(allSources(by).map((x) => x.message), ["lsp", "fullwidth"]);
  by = withSource(by, "lsp", []);
  assert.deepEqual(allSources(by).map((x) => x.message), ["fullwidth"]);
});
