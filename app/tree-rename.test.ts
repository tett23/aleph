import assert from "node:assert/strict";
import test from "node:test";
import { canRenameTreeItem, renameTarget } from "./tree-rename.ts";

const workspaces = ["/workspace"];
const projects = ["/workspace/book"];

test("ADR 0070 invariant 1: project root files are protected, nested names are not", () => {
  for (const name of ["plot.csv", "manifest.toml", "style.toml"]) {
    assert.equal(canRenameTreeItem(`/workspace/book/${name}`, workspaces, projects), false);
    assert.equal(canRenameTreeItem(`/workspace/book/draft/${name}`, workspaces, projects), true);
  }
  assert.equal(canRenameTreeItem("/workspace/book/styles/body.toml", workspaces, projects), true);
  assert.equal(canRenameTreeItem("/workspace", workspaces, projects), false);
  assert.equal(canRenameTreeItem("/outside/book/chapter.md", workspaces, projects), false);
  assert.equal(canRenameTreeItem("/workspace/parent", ["/workspace", "/workspace/parent/nested"], projects), false);
});

test("ADR 0070 invariant 2: only the requested path determines the destination", () => {
  assert.equal(renameTarget("/workspace/book/chapters/01.gm", "opening.gm"), "/workspace/book/chapters/opening.gm");
  assert.equal(renameTarget("/workspace/book/chapters", "drafts"), "/workspace/book/drafts");
});

test("ADR 0070 invariant 3: empty, same and path-like names are rejected", () => {
  for (const name of ["", " ", "chapters", ".", "..", "../elsewhere", "elsewhere/child", "elsewhere\\child"]) {
    assert.equal(renameTarget("/workspace/book/chapters", name), null);
  }
});
