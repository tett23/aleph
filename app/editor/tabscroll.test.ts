import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dragScroll, edges, reveal, wheelAmount } from "./tabscroll.ts";

// a bar 400px wide whose tabs are 144px each (the probe of docs/adr/0107)
const view = 400;

test("ADR 0107 I1: the revealed tab lies inside the view, or starts it when wider", () => {
  assert.equal(reveal({ start: 1152, width: 144, view, scroll: 0 }), 896); // the last of 9 tabs ends at the right edge
  assert.equal(reveal({ start: 144, width: 144, view, scroll: 500 }), 144); // hidden on the left: starts the view
  assert.equal(reveal({ start: 300, width: 600, view, scroll: 0 }), 300); // wider than the view
});

test("ADR 0107 I2: the scroll moves the least, and not at all for a visible tab", () => {
  assert.equal(reveal({ start: 0, width: 144, view, scroll: 0 }), 0);
  assert.equal(reveal({ start: 288, width: 144, view, scroll: 200 }), 200);
  assert.equal(reveal({ start: 288, width: 144, view, scroll: 33 }), 33); // ends exactly at the right edge
  assert.equal(reveal({ start: 288, width: 144, view, scroll: 32 }), 32);
  assert.equal(reveal({ start: 288, width: 144, view, scroll: 31 }), 32);
});

test("ADR 0107 I3: a vertical wheel scrolls an overflowing bar; a sideways one or a bar that fits is left alone", () => {
  const fits = { clientWidth: 400, scrollWidth: 400 };
  const over = { clientWidth: 400, scrollWidth: 401 };
  assert.equal(wheelAmount({ dx: 0, dy: 30, mode: 0 }, fits), 0);
  assert.equal(wheelAmount({ dx: 0, dy: 30, mode: 0 }, { clientWidth: 400, scrollWidth: 400 }), 0);
  assert.equal(wheelAmount({ dx: 0, dy: 30, mode: 0 }, over), 30);
  assert.equal(wheelAmount({ dx: 0, dy: -30, mode: 0 }, over), -30);
  assert.equal(wheelAmount({ dx: 20, dy: 20, mode: 0 }, over), 0);
  assert.equal(wheelAmount({ dx: 25, dy: 5, mode: 0 }, over), 0);
  assert.equal(wheelAmount({ dx: 0, dy: 3, mode: 1 }, over), 48);
  assert.equal(wheelAmount({ dx: 0, dy: 1, mode: 2 }, over), 400);
});

test("ADR 0107 I4: a shadow shows on a side only while tabs hide there", () => {
  assert.deepEqual(edges({ scrollLeft: 0, clientWidth: 400, scrollWidth: 400 }), { left: false, right: false });
  assert.deepEqual(edges({ scrollLeft: 0, clientWidth: 400, scrollWidth: 401 }), { left: false, right: true });
  assert.deepEqual(edges({ scrollLeft: 0.4, clientWidth: 400, scrollWidth: 1750 }), { left: false, right: true });
  assert.deepEqual(edges({ scrollLeft: 500, clientWidth: 400, scrollWidth: 1750 }), { left: true, right: true });
  assert.deepEqual(edges({ scrollLeft: 1350, clientWidth: 400, scrollWidth: 1750 }), { left: true, right: false });
  assert.deepEqual(edges({ scrollLeft: 1349.6, clientWidth: 400, scrollWidth: 1750 }), { left: true, right: false });
});

test("ADR 0107 I5: a dragged tab near an edge scrolls 8px a frame toward it", () => {
  const bar = { left: 100, width: 400 };
  assert.equal(dragScroll(100 + 24, bar), -8);
  assert.equal(dragScroll(100 + 25, bar), 0);
  assert.equal(dragScroll(100, bar), -8);
  assert.equal(dragScroll(500 - 24, bar), 8);
  assert.equal(dragScroll(500 - 25, bar), 0);
  assert.equal(dragScroll(300, bar), 0);
  assert.equal(dragScroll(120, { left: 100, width: 40 }), 0);
});

test("ADR 0107 I6: tabs do not shrink", () => {
  const css = readFileSync(new URL("../style.css", import.meta.url), "utf8");
  const rule = /^\.tab \{([^}]*)\}/m.exec(css);
  assert.ok(rule && /flex-shrink:\s*0/.test(rule[1]), "the .tab rule has flex-shrink: 0");
});

test("the frame of the tab bar does not take the class of a tab's view, which holds the editor", () => {
  const panes = readFileSync(new URL("./panes.ts", import.meta.url), "utf8");
  const strip = /<div class="tabstrip">(.*?)<\/div><div class="ebody">/.exec(panes);
  assert.ok(strip, "panes.ts builds the .tabstrip");
  const classes = [...strip[1].matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/));
  assert.ok(!classes.includes("tabview"), `the tab strip uses ${classes.join(", ")}`);
  const css = readFileSync(new URL("../style.css", import.meta.url), "utf8");
  for (const m of css.matchAll(/^\.tabview \{([^}]*)\}/gm)) assert.ok(!/display:\s*flex/.test(m[1]), "a plain .tabview is not a flex row");
});
