import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

test("ADR 0097 I4: image fetch or decode failure leaves the current DOM and scroll intact", async () => {
  const oldDocument = globalThis.document;
  const oldCreate = URL.createObjectURL;
  const oldRevoke = URL.revokeObjectURL;
  const revoked: string[] = [];
  const events = new EventTarget();
  const pane = Object.assign(events, {
    scrollLeft: 30, scrollTop: 50, clientWidth: 100, clientHeight: 100, scrollWidth: 300, scrollHeight: 300,
    classList: { toggle() {} }, replaceChildren() { throw new Error("the existing document was replaced"); },
  });
  let decode = async () => {};
  let read = async () => new ArrayBuffer(0);
  function scene() {
    const image = {
      src: "",
      dataset: { src: "/w/book/image.png" },
      getAttribute: () => image.src,
      removeAttribute() {},
      decode: () => decode(),
    };
    const element = { style: { setProperty() {} } };
    let child: typeof element | undefined;
    return {
      querySelector: () => child,
      replaceChildren: (el: typeof element) => { child = el; },
      querySelectorAll: () => [image],
    };
  }
  Object.assign(globalThis, { document: {
    createElement: (tag: string) => tag === "div" ? scene() : null,
    fonts: { ready: Promise.resolve() },
  } });
  Object.assign(URL, { createObjectURL: () => "blob:fixture", revokeObjectURL: (url: string) => revoked.push(url) });
  const server = await createServer({ configFile: false, server: { middlewareMode: true, ws: false }, appType: "custom" });
  try {
    const { api } = await server.ssrLoadModule("/app/api.ts");
    api.readBytes = () => read();
    const { preparePlain, previewPane } = await server.ssrLoadModule("/app/preview/render.ts");
    const target = { mode: "plain", vertical: false, workspace: "/w", project: "/w/book", paths: ["/w/book/main.gm"] };
    const failures: string[] = [];
    const updates = previewPane(pane, (error: unknown) => failures.push(String(error)));
    const prepare = () => preparePlain(pane, [{ title: "章", html: '<img data-src="/w/book/image.png">' }], false);
    read = async () => { throw new Error("read failed"); };
    await updates.request(target, 1, prepare);
    read = async () => new ArrayBuffer(0);
    decode = async () => { throw new Error("decode failed"); };
    await updates.request(target, 2, prepare);
    assert.deepEqual(failures, ["Error: read failed", "Error: decode failed"]);
    assert.deepEqual(revoked, ["blob:fixture"]);
    assert.deepEqual([pane.scrollLeft, pane.scrollTop], [30, 50]);
    updates.close();
  } finally {
    Object.assign(globalThis, { document: oldDocument });
    Object.assign(URL, { createObjectURL: oldCreate, revokeObjectURL: oldRevoke });
    await server.close();
  }
});
