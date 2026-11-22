import assert from "node:assert/strict";
import { test } from "node:test";
import { previewPosition, previewSize } from "./tree-drag-preview.ts";

test("ADR 0103 I3: preview offsets and flips independently in each axis", () => {
  const size = { width: 100, height: 20 };
  const viewport = { width: 320, height: 220 };
  assert.deepEqual(previewPosition({ x: 4, y: 4 }, size, viewport), { x: 16, y: 16 });
  assert.deepEqual(previewPosition({ x: 204, y: 184 }, size, viewport), { x: 216, y: 196 });
  assert.deepEqual(previewPosition({ x: 205, y: 184 }, size, viewport), { x: 93, y: 196 });
  assert.deepEqual(previewPosition({ x: 204, y: 185 }, size, viewport), { x: 216, y: 153 });
  assert.deepEqual(previewPosition({ x: 319, y: 219 }, size, viewport), { x: 207, y: 187 });
});

test("ADR 0103 I3: clamping and size limits also contain previews in tiny viewports", () => {
  for (const viewport of [
    { width: 600, height: 400 },
    { width: 248, height: 28 },
    { width: 100, height: 8 },
    { width: 2, height: 1 },
    { width: 0, height: 0 },
  ]) {
    const size = previewSize(viewport);
    assert.ok(size.width >= 0 && size.width <= 240);
    for (const pointer of [{ x: -1, y: -1 }, { x: viewport.width, y: viewport.height }]) {
      const at = previewPosition(pointer, size, viewport);
      assert.ok(at.x >= 0 && at.x + size.width <= viewport.width);
      assert.ok(at.y >= 0 && at.y + size.height <= viewport.height);
    }
  }
  const viewport = { width: 100, height: 50 };
  assert.deepEqual(previewSize(viewport), { width: 92, height: 42 });
  assert.deepEqual(previewPosition({ x: 50, y: 25 }, previewSize(viewport), viewport), { x: 4, y: 4 });
});
