import { createEditor, type Editor } from "../ed/editor.ts";
import type { GutterSnapshot } from "../difftab/snapshot.ts";
import { activeSnapshot, drawSnapshot } from "../difftab/snapshot-view.ts";
import { createStore } from "../store.ts";

const host = document.querySelector<HTMLElement>("#host")!;
const nativeViewport = window.visualViewport!;
let viewportOverride: Pick<VisualViewport, "width" | "height" | "offsetTop" | "offsetLeft" | "scale"> | undefined;
Object.defineProperty(window, "visualViewport", { configurable: true, get: () => viewportOverride ?? nativeViewport });
type ProbeWindow = typeof window & {
  webkit: { messageHandlers: Record<string, { postMessage: (message: string) => void }> };
  resumeProbe: () => void;
};
const probe = window as ProbeWindow;
const cases = new Set<string>();
const check = (name: string, pass: boolean, debug?: unknown) => {
  if (!pass) throw new Error(`${name} ${JSON.stringify(debug) ?? ""}`);
  cases.add(name);
};
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const afterFrames = async (n: number) => { for (let i = 0; i < n; i++) await frame(); };
const popup = () => document.querySelector<HTMLElement>(".ed-diff-hover");
const marker = () => host.querySelector<HTMLElement>(".chg-slot:has(.chg)")!;
const fire = (target: Element, type: string) => {
  const r = target.getBoundingClientRect();
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: (r.left + r.right) / 2, clientY: (r.top + r.bottom) / 2 }));
};
const escape = (isComposing = false) => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing, bubbles: true, cancelable: true }));
const realSet = window.setTimeout.bind(window);
const realClear = window.clearTimeout.bind(window);
let now = 0;
let nextId = -1;
const timers = new Map<number, { due: number; run: () => void }>();
const setTimer = (fn: TimerHandler, delay?: number, ...args: unknown[]) => {
  if (delay !== 300 || typeof fn !== "function") return realSet(fn, delay, ...args);
  const id = nextId--;
  timers.set(id, { due: now + delay, run: () => fn(...args) });
  return id;
};
const clearTimer = (id?: number) => {
  if (id !== undefined && id < 0) timers.delete(id);
  else realClear(id);
};
Object.assign(window, { setTimeout: setTimer, clearTimeout: clearTimer });
const tick = (ms: number) => {
  now += ms;
  for (const [id, event] of [...timers]) {
    if (event.due <= now) { timers.delete(id); event.run(); }
  }
};
let opened: GutterSnapshot | undefined;
let saves = 0;
const unchanged = Array.from({ length: 300 }, (_, n) => `common ${n}`).join("\n");
const before = ["共通", "猫".repeat(900), ...Array.from({ length: 260 }, (_, n) => `旧 ${n}`), "旧末尾", unchanged].join("\n");
const after = ["共通", "犬".repeat(900), ...Array.from({ length: 260 }, (_, n) => `新 ${n}`), "新末尾<script>", unchanged].join("\n");
const make = (vertical: boolean, base: () => Promise<string>) => createEditor({
  parent: host, kind: "txt", text: after,
  grid: { chars: 32, lines: 12, vertical }, chars: 32, invisibles: false, vertical, style: "prose",
  base, onChange: () => {}, onSave: () => { saves++; }, onOpenDiff: (snapshot) => { opened = snapshot; },
});
const enter = () => { fire(marker(), "mousemove"); tick(300); };
const bounded = async (count: number, required = true) => {
  for (let i = 0; i < count; i++) {
    await frame();
    const box = popup();
    if (!box || getComputedStyle(box).visibility !== "visible") {
      if (required) check("ADR 0104 I7: measurable frame is visible", false);
      continue;
    }
    const r = box.getBoundingClientRect();
    const v = viewportOverride ?? nativeViewport;
    const x = Math.min(8, v.width / 4);
    const y = Math.min(8, v.height / 4);
    const epsilon = 0.05;
    check("ADR 0104 I7: every visible frame fits visual bounds", r.left + epsilon >= v.offsetLeft + x &&
      r.top + epsilon >= v.offsetTop + y && r.right - epsilon <= v.offsetLeft + v.width - x &&
      r.bottom - epsilon <= v.offsetTop + v.height - y && r.width <= 560.05 && r.height <= 560.05, { rect: r.toJSON(), viewport: v });
  }
};
const adjust = (zoom: number, width: number, height: number) =>
  new Promise<void>((resolve) => {
    probe.resumeProbe = resolve;
    probe.webkit.messageHandlers.zoom.postMessage(JSON.stringify({ zoom, width, height }));
  });

const nativeWheel = (target: Element, delta: number) => new Promise<void>((resolve) => {
  const rect = target.getBoundingClientRect();
  probe.resumeProbe = resolve;
  probe.webkit.messageHandlers.wheel.postMessage(JSON.stringify({
    x: (rect.left + rect.right) / 2,
    y: (rect.top + rect.bottom) / 2,
    delta,
  }));
});

const checkDiffTab = async (editor: Editor, clicked: GutterSnapshot) => {
  const store = createStore();
  const workspace = "/fixture";
  const path = workspace + "/test.txt";
  const grid = { chars: 32, lines: 12, vertical: false };
  store.dispatch({ type: "workspace", path: workspace });
  store.dispatch({ type: "open", docs: [{ path, kind: "txt", workspace, project: null, text: after, saved: before, grid }] });
  const snapshot = { ...clicked, path, workspace };
  store.dispatch({ type: "showDiff", snapshot });
  const container = document.createElement("div");
  container.className = "diff-tab";
  const head = document.createElement("div");
  const body = document.createElement("div");
  body.className = "dbody";
  container.append(head, body);
  document.body.append(container);
  const readers: ((base: string | null | false) => void)[] = [];
  const ctx = { store, editors: new Map([[path, editor]]), baseText: () => new Promise<string | null | false>((resolve) => readers.push(resolve)) };
  const draw = () => drawSnapshot(ctx, head, body, activeSnapshot(store.get())!);
  const reload = () => head.querySelector<HTMLButtonElement>("[data-snapshot-reload]")!.click();
  draw();
  check("ADR 0104 I1, I5, A3: the tab renders the unsaved snapshot and escapes its source",
    head.textContent!.includes("未保存") && !!body.querySelector("[data-snapshot-target]") &&
    body.textContent!.includes("新末尾<script>") && !body.querySelector("script"));
  editor.setText(after + " 最新");
  check("ADR 0104 I1: subsequent edits leave the clicked snapshot intact", activeSnapshot(store.get())!.text === after);
  reload();
  reload();
  readers[1](before + " 新しい比較元");
  await frame();
  const latest = activeSnapshot(store.get())!;
  check("ADR 0104 I3: reload reads the latest editor text and the new base",
    latest.text.endsWith(" 最新") && latest.base?.endsWith(" 新しい比較元") === true);
  readers[0](before);
  await frame();
  check("ADR 0104 I3: the late base read cannot replace the newer snapshot", activeSnapshot(store.get()) === latest);
  draw();
  ctx.editors.delete(path);
  reload();
  check("ADR 0104 I3: reloading after closing the editor displays the reason", body.textContent!.includes("閉じている"));
  head.querySelector<HTMLButtonElement>("[data-snapshot-workspace]")!.click();
  check("ADR 0104 A3: the return control selects workspace scope in the same tab", !activeSnapshot(store.get()) && !!store.get().panes[0].tabs.find((tab) => tab.diff));
  editor.setText(after);
  await afterFrames(2);
  await new Promise<void>((resolve) => realSet(resolve, 450));
  container.remove();
};

const run = async () => {
  host.style.inset = "30px auto auto 30px";
  let editor: Editor = make(false, async () => before);
  await afterFrames(2);
  editor.focus();
  editor.edit!.core.select({ anchor: 0, head: 1 }, true);
  editor.edit!.view.syncSelection();
  const selection = JSON.stringify(editor.edit!.core.sel());
  const row = marker().closest(".ed-line")!.getBoundingClientRect().toJSON();
  fire(marker(), "mousemove");
  tick(299);
  check("ADR 0104 I2: absent at 299 ms", popup() === null);
  tick(1);
  await bounded(2);
  tick(120_000);
  check("ADR 0104 I2: kept over the marker", popup() !== null);
  const original = popup()!;
  const details = original.querySelector("button")!;
  const scrollable = [...original.querySelectorAll<HTMLElement>(".ed-diff-scroll")];
  const scroller = host.querySelector<HTMLElement>(".ed-scroll")!;
  const scrollTop = scroller.scrollTop;
  for (const [i, pane] of scrollable.entries()) {
    fire(pane, "mousemove");
    await nativeWheel(pane, -80);
    check("ADR 0104 I8: a native WebKit wheel scrolls inside the hover", pane.scrollTop > 0, pane.scrollTop);
    pane.scrollTop = pane.scrollHeight;
    await frame();
    check("ADR 0104 I8: both tails are reachable inside the hover",
      pane.scrollTop > 0 && pane.scrollHeight - pane.scrollTop - pane.clientHeight < 2 &&
      pane.textContent!.endsWith(i ? "新末尾<script>" : "旧末尾"));
    await nativeWheel(pane, -100);
    check("ADR 0104 I8: native boundary wheel does not scroll the editor",
      getComputedStyle(pane).overscrollBehaviorY === "contain" && scroller.scrollTop === scrollTop && popup() === original);
  }
  tick(120_000);
  check("ADR 0104 I2, I8: internal scrolling and dwelling retain the hover", popup() === original && scroller.scrollTop === scrollTop);
  check("ADR 0104 I5: fixture text remains text", !original.querySelector("script"));
  check("ADR 0104 I4: layout and selection preserved", JSON.stringify(row) === JSON.stringify(marker().closest(".ed-line")!.getBoundingClientRect().toJSON()) &&
    JSON.stringify(editor.edit!.core.sel()) === selection);
  check("ADR 0104 A3: details is underlined", getComputedStyle(details).textDecorationLine === "underline");
  fire(details, "mousedown");
  fire(details, "click");
  check("ADR 0104 I1, I4, A3: details opens the unsaved comparison without touching selection or save", opened?.base === before && opened?.text === after &&
    popup() === null && saves === 0 && JSON.stringify(editor.edit!.core.sel()) === selection);
  opened = undefined;
  fire(marker(), "mousedown");
  fire(marker(), "click");
  check("ADR 0104 I1, I4, A3: clicking the marker opens the same unsaved comparison", (opened as GutterSnapshot | undefined)?.text === after && saves === 0 &&
    JSON.stringify(editor.edit!.core.sel()) === selection);

  fire(marker(), "mousemove");
  escape();
  tick(120_000);
  check("ADR 0104 I3: Esc cancels a pending hover", popup() === null);
  enter();
  escape();
  check("ADR 0104 A2: Esc closes an open hover", popup() === null);
  enter();
  escape(true);
  check("ADR 0104 A2: IME Esc remains with the IME", popup() !== null);
  enter();
  document.body.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 0, clientY: 0 }));
  check("ADR 0104 A2: leaving both regions closes the hover", popup() === null);
  enter();
  scroller.scrollTop += 20;
  await afterFrames(2);
  check("ADR 0104 I3: target scrolling closes the hover", popup() === null);
  scroller.scrollTop = 0;
  await afterFrames(2);
  enter();
  editor.setText(after + " edit");
  check("ADR 0104 I3: editing closes the hover", popup() === null);
  await checkDiffTab(editor, opened as GutterSnapshot | undefined ?? (() => { throw new Error("Missing clicked snapshot"); })());
  editor.destroy();

  document.body.classList.add("theme-dark");
  editor = make(true, async () => before);
  await afterFrames(2);
  for (const inset of ["10px auto auto 10px", "10px 10px auto auto", "auto 10px 10px auto", "auto auto 10px 10px"]) {
    host.style.inset = inset;
    await frame();
    enter();
    await bounded(3);
  }
  check("ADR 0104 A1, A4: vertical writing and dark theme retain the same hover", !!popup());
  for (const size of [576, 575]) {
    viewportOverride = { offsetLeft: 3, offsetTop: 5, width: size, height: size, scale: 1 };
    await bounded(3);
  }
  viewportOverride = { offsetLeft: 31, offsetTop: 17, width: 180, height: 49, scale: 2 };
  await bounded(4);
  check("ADR 0104 I8: tiny viewport uses a single scroll region", popup()!.classList.contains("whole-scroll"));
  const whole = popup()!;
  whole.scrollTop = whole.scrollHeight;
  check("ADR 0104 I8: fallback can reach the details control", whole.scrollTop > 0 &&
    whole.querySelector("button")!.getBoundingClientRect().bottom <= whole.getBoundingClientRect().bottom + 1);
  viewportOverride = { offsetLeft: 60, offsetTop: 25, width: 126, height: 65, scale: 4 };
  await bounded(4);
  viewportOverride = { ...viewportOverride, width: 0 };
  await afterFrames(2);
  check("ADR 0104 I7: zero-sized viewport hides the frame", getComputedStyle(popup()!).visibility === "hidden");
  viewportOverride = undefined;
  await bounded(2);
  for (const zoom of [2, 4, 1]) {
    const changed = adjust(zoom, 440, 320);
    await bounded(5, false);
    await changed;
    await bounded(2, false);
    if (!popup()) enter();
    await bounded(2);
  }
  editor.destroy();
  check("ADR 0104 I3: destroying the editor closes the hover", popup() === null);
  probe.webkit.messageHandlers.report.postMessage(JSON.stringify({ ok: true, checks: [...cases] }));
};
void run();
