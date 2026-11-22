// Open git-project-settings.html in a separate Chrome instance with remote debugging enabled.
// Run with the debug endpoint as the first argument, e.g. http://127.0.0.1:19106.
import assert from "node:assert/strict";

const endpoint = process.argv[2] ?? "http://127.0.0.1:19106";
const tab = (await (await fetch(new URL("/json/list", endpoint))).json()).find((entry) => entry.url.includes("/git-project-settings.html"));
assert.ok(tab, "fixture tab");
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let i = 0;
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++i;
  const listen = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id !== id) return;
    ws.removeEventListener("message", listen);
    if (message.error) reject(message.error);
    else resolve(message.result);
  };
  ws.addEventListener("message", listen);
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const response = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception.description);
  return response.result.value;
};
const evaluateReady = async (expr) => {
  for (let attempts = 0; attempts < 50; attempts++) {
    const result = await evaluate(expr);
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Fixture did not settle: " + expr);
};
try {
  await call("Page.reload");
  await new Promise((resolve) => setTimeout(resolve, 500));
  await evaluateReady("Boolean(window.gitProjectFixture)");
  const before = await evaluate("gitProjectFixture.tree()");
  assert.equal(before.focus, "/workspace/星/a.gm");
  const button = 'document.querySelectorAll("button[data-project-git]")[1]';
  assert.equal(await evaluate(button + '.getAttribute("aria-label")'), "月の Git 設定を開く");
  assert.equal(await evaluate(button + '.title'), "Git 設定を開く");
  const { x, y } = await evaluate(button + ".getBoundingClientRect().toJSON()");
  const mouse = (type, dx = 0) => call("Input.dispatchMouseEvent", { type, x: x + 6 + dx, y: y + 6, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
  await mouse("mousePressed");
  await mouse("mouseMoved", 30);
  assert.equal(await evaluate('!!document.querySelector(".tree-drag-preview")'), false);
  await mouse("mouseMoved");
  await mouse("mouseReleased");
  await evaluateReady('document.activeElement.matches("input[data-identity=name]")');
  assert.equal(await evaluate('document.querySelector("[role=dialog]").getAttribute("aria-label")'), "プロジェクト設定");
  assert.equal(await evaluate('document.querySelector("[data-global-identity]")'), null);
  assert.deepEqual(await evaluate("gitProjectFixture.reads"), ["/workspace/月"]);
  await evaluate('document.activeElement.value = "unsaved"');
  const key = async (key, code, windowsVirtualKeyCode, modifiers = 0) => {
    await call("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode, modifiers, ...(key === "Enter" ? { text: "\r", unmodifiedText: "\r" } : {}) });
    await call("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode, modifiers });
  };
  await key("Escape", "Escape", 27);
  assert.equal(await evaluate("document.activeElement === " + button), true);
  await key("Enter", "Enter", 13);
  await evaluateReady('document.activeElement.matches("input[data-identity=name]")');
  assert.deepEqual(await evaluate("gitProjectFixture.reads"), ["/workspace/月", "/workspace/月"]);
  assert.equal(await evaluate("document.activeElement.value"), "");
  await key("Escape", "Escape", 27);
  await evaluate("gitProjectFixture.showIdentityRequired()");
  assert.equal(await evaluate('document.activeElement.matches("[data-cancel]")'), true);
  await key("Tab", "Tab", 9);
  assert.equal(await evaluate('document.activeElement.matches("[data-global]")'), true);
  await key("Tab", "Tab", 9);
  assert.equal(await evaluate('document.activeElement.matches("[data-local]")'), true);
  await key("Tab", "Tab", 9, 8);
  assert.equal(await evaluate('document.activeElement.matches("[data-global]")'), true);
  await key("Escape", "Escape", 27);
  assert.equal(await evaluate("document.activeElement === " + button), true);
  assert.deepEqual(await evaluate("gitProjectFixture.tree()"), before);
  assert.deepEqual(await evaluate("gitProjectFixture.writes"), []);
  console.log("ADR 0105 A2: mouse, Enter, Escape, target, focus, selection, expansion, drag, no write passed");
} finally {
  ws.close();
}
