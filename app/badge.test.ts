import assert from "node:assert/strict";
import { test } from "node:test";
import { badgeText } from "./notify.ts";

test("the unread badge shows the count up to 99 and 99+ from 100", () => {
  for (const [count, text] of [[1, "1"], [9, "9"], [10, "10"], [99, "99"], [100, "99+"], [101, "99+"], [12345, "99+"]] as const)
    assert.equal(badgeText(count), text, String(count));
});
