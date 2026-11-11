import { test } from "node:test";
import assert from "node:assert/strict";
import { createPageInputs, pageSaveTiming } from "./page-saves.ts";

test("0072 conditions 1, 3, 4 and 5: schedule only changed final saves of eligible projects", () => {
  assert.equal(pageSaveTiming("explicit", "a", "b", true), "now");
  assert.equal(pageSaveTiming("automatic", "a", "b", true), "wait");
  for (const kind of ["explicit", "automatic"] as const) {
    assert.equal(pageSaveTiming(kind, "a", "a", true), null);
    assert.equal(pageSaveTiming(kind, "a", "b", false), null);
  }
  assert.equal(pageSaveTiming("intermediate", "a", "b", true), null);
});

test("0072 conditions 2 and 5: compare saved content with the last successful build across files", () => {
  const inputs = createPageInputs();
  inputs.save("a", "one", "two");
  inputs.save("a", "two", "one");
  assert.equal(inputs.changed(), false);
  inputs.save("a", "one", "two");
  const running = inputs.snapshot();
  inputs.save("a", "two", "three");
  inputs.save("b", "old", "new");
  inputs.publish(running);
  assert.equal(inputs.changed(), true);
  inputs.save("a", "three", "two");
  assert.equal(inputs.changed(), true);
  inputs.save("b", "new", "old");
  assert.equal(inputs.changed(), false);
});
