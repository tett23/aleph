import { test } from "node:test";
import assert from "node:assert/strict";
import { esc } from "./esc.ts";

test("escapes the five characters", () => {
  assert.equal(esc(`<a href="x">'&'</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  assert.equal(esc("霧笛"), "霧笛");
});
