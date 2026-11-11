import assert from "node:assert/strict";
import test from "node:test";
import { selectedGmInTreeOrder } from "./chapter-export.ts";

test("ADR 0066 invariant 2: export follows displayed order and only accepts selected gm", () => {
  const shown = ["/w/a.gm", "/w/b.md", "/w/c.gm"];
  assert.deepEqual(selectedGmInTreeOrder(shown, ["/w/c.gm", "/w/a.gm"]), ["/w/a.gm", "/w/c.gm"]);
  assert.equal(selectedGmInTreeOrder(shown, []), null);
  assert.equal(selectedGmInTreeOrder(shown, ["/w/a.gm", "/w/b.md"]), null);
});
