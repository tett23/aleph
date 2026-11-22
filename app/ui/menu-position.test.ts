import assert from "node:assert/strict";
import test from "node:test";
import { menuBounds, menuPosition } from "./menu-position.ts";

const bounds = menuBounds({ left: 0, top: 0, width: 300, height: 200 });
const menu = { width: 80, height: 25 };

test("ADR 0095 I1: a one-item menu opens underneath an anchor in the middle", () => {
  assert.deepEqual(menuPosition({ left: 120, top: 80, bottom: 100 }, menu, bounds), { left: 120, top: 104 });
});

test("ADR 0095 I1: the bottom-right edge shifts the menu left and above the anchor", () => {
  assert.deepEqual(menuPosition({ left: 285, top: 178, bottom: 194 }, menu, bounds), { left: 216, top: 149 });
});

test("ADR 0095 I1: exact fit stays below and one extra pixel flips it above", () => {
  const anchor = { left: 216, top: 150, bottom: 167 };
  assert.deepEqual(menuPosition(anchor, menu, bounds), { left: 216, top: 171 });
  assert.deepEqual(menuPosition(anchor, { width: 81, height: 26 }, bounds), { left: 215, top: 120 });
});

test("ADR 0095 I1: an anchor offscreen and a menu taller than either side are clamped", () => {
  const tall = { width: 80, height: 150 };
  assert.deepEqual(menuPosition({ left: -50, top: -90, bottom: -70 }, tall, bounds), { left: 4, top: 4 });
  assert.deepEqual(menuPosition({ left: 350, top: 270, bottom: 290 }, tall, bounds), { left: 216, top: 46 });
  assert.deepEqual(menuPosition({ left: 120, top: 80, bottom: 100 }, tall, bounds), { left: 120, top: 46 });
});

test("ADR 0095 I1: an oversized menu is placed at the bounds origin", () => {
  const panned = menuBounds({ left: 50, top: 100, width: 300, height: 200 });
  assert.deepEqual(menuPosition({ left: 120, top: 150, bottom: 170 }, { width: 1000, height: 400 }, panned), { left: 54, top: 104 });
});

test("ADR 0095 I1: each viewport axis below eight pixels uses no margin", () => {
  assert.deepEqual(menuBounds({ left: 50, top: 100, width: 7, height: 9 }), { left: 50, top: 104, width: 7, height: 1 });
  assert.deepEqual(menuBounds({ left: 50, top: 100, width: 8, height: 7 }), { left: 54, top: 100, width: 0, height: 7 });
});
