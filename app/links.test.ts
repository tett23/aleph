import { test } from "node:test";
import assert from "node:assert/strict";
import { linkAction } from "./links.ts";

test("links in a preview: jump inside, ask for the browser, open in Aleph, or nothing (docs/adr/0044)", () => {
  assert.deepEqual(linkAction("#fn-1", false), { kind: "jump", id: "fn-1" });
  assert.deepEqual(linkAction("#%E6%B3%A8", false), { kind: "jump", id: "注" });
  assert.deepEqual(linkAction("https://example.com/a", false), { kind: "browser", url: "https://example.com/a" });
  assert.deepEqual(linkAction(" HTTP://example.com", false), { kind: "browser", url: "HTTP://example.com" });
  assert.deepEqual(linkAction("霧笛", true), { kind: "aleph" });
  for (const href of ["file:///etc/passwd", "02.xhtml#a", "../a.md", "javascript:alert(1)", "java\tscript:alert(1)", "mailto:a@example.com", "#", "", null]) {
    assert.deepEqual(linkAction(href, false), { kind: "none" }, String(href));
  }
});
