import assert from "node:assert/strict";
import { test } from "node:test";
import { treeDrop } from "./tree-move.ts";

const roots = ["/w", "/w/registered", "/external"];
const projects = ["/w/works/a", "/w/b", "/w/registered/book"];

test("ADR 0100 I1, I2, I3: a drop retains the name, and the same parent is a no-op", () => {
  assert.deepEqual(treeDrop("/w/loose/x.gm", "/w/b", "/w", roots, projects), { kind: "move", to: "/w/b/x.gm" });
  assert.deepEqual(treeDrop("/w/loose/empty", "/w", "/w", roots, projects), { kind: "move", to: "/w/empty" });
  assert.equal(treeDrop("/w/loose/x.gm", "/w/loose", "/w", roots, projects).kind, "noop");
});

test("ADR 0100 I2, I3: reject own descendants, workspace roots, other workspaces and protected settings", () => {
  for (const [from, dir] of [
    ["/w/works", "/w/works/a"], ["/w/works", "/w/works"],
    ["/w", "/w/registered"], ["/w/registered", "/w/loose"], ["/w/registered/book", "/w/loose"],
    ["/w/loose/x.gm", "/external"], ["/w/loose/x.gm", "/w/registered"],
    ["/w/b/manifest.toml", "/w/loose"], ["/w/b/style.toml", "/w/loose"], ["/w/b/plot.csv", "/w/loose"],
  ]) assert.equal(treeDrop(from, dir, "/w", roots, projects).kind, "invalid", `${from} → ${dir}`);
});

test("ADR 0100 I2, I5: a regular folder may change project, while a project cannot be nested", () => {
  assert.equal(treeDrop("/w/works", "/w/b", "/w", roots, projects).kind, "invalid");
  assert.equal(treeDrop("/w/works/a", "/w/b", "/w", roots, projects).kind, "invalid");
  assert.equal(treeDrop("/w/works/a/drafts", "/w/b", "/w", roots, projects).kind, "move");
  assert.equal(treeDrop("/w/works", "/w/loose", "/w", roots, projects).kind, "move");
});
