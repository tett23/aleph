import assert from "node:assert/strict";
import test from "node:test";
import { keepScroll } from "./scroll.ts";

type Box = { scrollTop: number; scrollLeft: number };
const host = (box: Box | null) => {
  const el = { current: box, querySelector: (selector: string) => (selector === ".file-tree" ? el.current : null) };
  return el;
};

test("a redraw that replaces the scrolled element keeps its position", () => {
  const el = host({ scrollTop: 480, scrollLeft: 12 });
  const fresh: Box = { scrollTop: 0, scrollLeft: 0 };
  keepScroll(el, ".file-tree", () => {
    el.current = fresh;
  });
  assert.deepEqual(fresh, { scrollTop: 480, scrollLeft: 12 });
});

test("the first draw, with nothing scrolled before, leaves the new element at the top", () => {
  const el = host(null);
  const fresh: Box = { scrollTop: 0, scrollLeft: 0 };
  keepScroll(el, ".file-tree", () => {
    el.current = fresh;
  });
  assert.deepEqual(fresh, { scrollTop: 0, scrollLeft: 0 });
});

test("a redraw that leaves no such element does nothing more", () => {
  const el = host({ scrollTop: 30, scrollLeft: 0 });
  assert.doesNotThrow(() =>
    keepScroll(el, ".file-tree", () => {
      el.current = null;
    }),
  );
});

test("a host without querySelector (a test's fake element) is drawn as before", () => {
  let drawn = false;
  keepScroll({} as never, ".file-tree", () => {
    drawn = true;
  });
  assert.equal(drawn, true);
});
