import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

type Style = Record<string, string>;
type FakeElement = {
  children: FakeElement[];
  style: Style;
  html: string;
  onmouseup: (event: { button: number }) => void;
  append: (child: FakeElement) => void;
  remove: () => void;
  contains: (child: FakeElement) => boolean;
  getBoundingClientRect: () => { width: number; height: number; top: number; left: number; right: number; bottom: number };
};
const element = (): FakeElement => {
  const children: FakeElement[] = [];
  const node = {
    children,
    style: {} as Style,
    html: "",
    onmouseup: (_event: { button: number }) => {},
    append(child: FakeElement) {
      children.push(child);
    },
    remove() {
      const i = menus.indexOf(node);
      if (i >= 0) menus.splice(i, 1);
    },
    contains(child: FakeElement) {
      return child === node || children.includes(child);
    },
    getBoundingClientRect() {
      assert.ok(menus.includes(node), "measure the mounted menu");
      const width = Math.min(173, parseFloat(node.style.maxWidth) || Infinity);
      const height = Math.min(90, parseFloat(node.style.maxHeight) || Infinity);
      const top = parseFloat(node.style.top);
      const left = parseFloat(node.style.left);
      return { width, height, top, left, right: left + width, bottom: top + height };
    },
  };
  return node;
};
const menus: FakeElement[] = [];

test("ADR 0095 I1, I2, I3: the mounted menu fits, scrolls and releases its listeners on close", async () => {
  const mouseup = new EventTarget();
  const viewportEvents = new EventTarget();
  const viewport = Object.assign(viewportEvents, { width: 310, height: 200, offsetLeft: 0, offsetTop: 0 });
  const resize = new EventTarget();
  const win = Object.assign(resize, { visualViewport: viewport, innerWidth: 310, innerHeight: 200 });
  const doc = Object.assign(mouseup, {
    body: { append: (node: FakeElement) => menus.push(node) },
    querySelectorAll: () => menus.slice(),
    createElement(tag: string) {
      assert.equal(tag, "template");
      const node = element();
      return {
        set innerHTML(html: string) {
          node.html = html;
          for (const [, key, value] of html.matchAll(/(top|left):([^;"]+)/g)) node.style[key] = value;
        },
        content: { firstElementChild: node },
      };
    },
  });
  let outsideChecks = 0;
  const anchor = {
    getBoundingClientRect: () => ({ left: 240, top: 180, bottom: 195 }),
    contains() {
      outsideChecks++;
      return false;
    },
  };
  const globals = { document: globalThis.document, window: globalThis.window, innerWidth: globalThis.innerWidth };
  Object.assign(globalThis, { document: doc, window: win, innerWidth: 310 });
  const server = await createServer({ configFile: false, server: { middlewareMode: true, ws: false }, appType: "custom" });
  try {
    const { menu } = await server.ssrLoadModule("/app/ui/dom.ts");
    const runs: string[] = [];
    const items = [
      { label: "first", run: () => runs.push("first") },
      "-",
      { label: "last".repeat(100), run: () => runs.push("last") },
    ];
    menu(anchor, items);
    const opened = menus[0];
    assert.equal(opened.getBoundingClientRect().bottom, 176);
    assert.equal(opened.getBoundingClientRect().right, 306);
    assert.deepEqual(opened.children.map((child) => child.html), [
      "<div><span>first</span></div>",
      "<hr>",
      `<div><span>${"last".repeat(100)}</span></div>`,
    ]);
    assert.equal(opened.style.overflow, "auto");
    Object.assign(viewport, { width: 130, height: 70, offsetLeft: 10, offsetTop: 20 });
    viewportEvents.dispatchEvent(new Event("resize"));
    assert.equal(opened.style.maxWidth, "122px");
    assert.equal(opened.style.maxHeight, "62px");
    assert.deepEqual(opened.getBoundingClientRect(), { width: 122, height: 62, left: 14, top: 24, right: 136, bottom: 86 });
    assert.deepEqual(runs, []);

    // Opening another menu, choosing and pressing outside all release their listeners.
    menu(anchor, items);
    const replacement = menus[0];
    replacement.children[2].onmouseup({ button: 0 });
    assert.deepEqual(runs, ["last"]);
    menu(anchor, items);
    mouseup.dispatchEvent(new Event("mouseup"));
    assert.equal(menus.length, 0);
    mouseup.dispatchEvent(new Event("mouseup"));
    assert.equal(outsideChecks, 1);
    resize.dispatchEvent(new Event("resize"));
    viewportEvents.dispatchEvent(new Event("scroll"));
  } finally {
    menus.length = 0;
    await server.close();
    Object.assign(globalThis, globals);
  }
});
