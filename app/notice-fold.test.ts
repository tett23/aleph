import assert from "node:assert/strict";
import { test } from "node:test";
import { createFolds, foldKey } from "./notice-fold.ts";

const note = (id: number, key: string | null = null) => ({ id, key });

test("ADR 0111 I1, I2: a note is not long until measured long, and a long one starts folded", () => {
  const folds = createFolds();
  const k = foldKey(note(1));
  assert.deepEqual(folds.of(k), { long: false, open: false });
  assert.equal(folds.measured(k, false), false);
  assert.deepEqual(folds.of(k), { long: false, open: false });
  assert.equal(folds.measured(k, true), true);
  assert.deepEqual(folds.of(k), { long: true, open: false });
  assert.equal(folds.measured(k, true), false);
});

test("ADR 0111 I3: pressing toggles that note only", () => {
  const folds = createFolds();
  const a = foldKey(note(1));
  const b = foldKey(note(2));
  folds.measured(a, true);
  folds.measured(b, true);
  folds.toggle(a);
  assert.equal(folds.of(a).open, true);
  assert.equal(folds.of(b).open, false);
  folds.toggle(a);
  assert.equal(folds.of(a).open, false);
});

test("ADR 0111 I4: the state follows the key across a replacement and an update, and goes when the note leaves", () => {
  const folds = createFolds();
  const first = foldKey(note(1, "build"));
  folds.measured(first, true);
  folds.toggle(first);
  const replaced = foldKey(note(7, "build"));
  assert.equal(replaced, first);
  folds.keep(new Set([replaced]));
  assert.equal(folds.of(replaced).open, true);
  // an update keeps the id, so the key is the same; a shorter text is measured again
  folds.measured(replaced, false);
  assert.deepEqual(folds.of(replaced), { long: false, open: true });
  folds.keep(new Set());
  assert.deepEqual(folds.of(foldKey(note(9, "build"))), { long: false, open: false });
});

test("ADR 0111 I4: a note without a key is kept by its id", () => {
  assert.notEqual(foldKey(note(1)), foldKey(note(2)));
  assert.notEqual(foldKey(note(1)), foldKey(note(1, "1")));
});
