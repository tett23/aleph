// Checks ADR 0111 I1, I2, I5 and I6 in a browser: open notice-fold.html from the Vite dev
// server; the result is written to #result and to window.noticeFoldResult. Resize the
// window and call window.noticeFoldRun() again to check another height.
import { notifications, notify } from "../ui/notices.ts";

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const results: string[] = [];
const run = (name: string, test: () => void) => {
  test();
  results.push(name);
};
// timers, not animation frames: a hidden window does not run animation frames, and layout is read synchronously
const frame = () => new Promise((resolve) => setTimeout(resolve, 30));
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");
const stack = () => document.querySelector<HTMLElement>(".toasts")!;
const toasts = () => [...stack().querySelectorAll<HTMLElement>(":scope > .nt")];
const toastOf = (text: string) => toasts().find((t) => t.querySelector(".msg")!.textContent === text)!;
const button = (t: HTMLElement) => t.querySelector<HTMLElement>("[data-fold]");
const press = (el: HTMLElement) => el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
const clear = async () => {
  for (const n of notifications().shown().notes) notifications().dismissByUser(n.id);
  notifications().expand(false);
  await frame();
};
const inWindow = (r: DOMRect) => r.top >= -0.5 && r.bottom <= innerHeight + 0.5 && r.left >= -0.5 && r.right <= innerWidth + 0.5;
const within = (inner: DOMRect, outer: DOMRect) => inner.top >= outer.top - 0.5 && inner.bottom <= outer.bottom + 0.5;
/** Scrolls the stack so the toast's top shows, then checks its × is inside the stack's visible box (I6). */
const closeReachable = (t: HTMLElement) => {
  const s = stack();
  s.scrollTop += t.getBoundingClientRect().top - s.getBoundingClientRect().top - 12;
  return within(t.querySelector<HTMLElement>("[data-x]")!.getBoundingClientRect(), s.getBoundingClientRect());
};

const main = async () => {
  results.length = 0;
  await clear();
  const wrapped = "折り返す文".repeat(60);
  notify({ message: "", sticky: true });
  notify({ message: lines(6), sticky: true });
  notify({ message: lines(7), sticky: true });
  notify({ message: wrapped, sticky: true });
  await frame();
  await frame();
  run("ADR 0111 I1: an empty text and a text of exactly six lines have no button", () => {
    check(!button(toastOf("")), "empty");
    check(!button(toastOf(lines(6))), "six lines");
  });
  run("ADR 0111 I2: seven lines, by newlines or by wrapping, fold with すべて表示", () => {
    for (const text of [lines(7), wrapped]) {
      const t = toastOf(text);
      check(button(t)?.textContent === "すべて表示", `button ${text.slice(0, 12)}`);
      const msg = t.querySelector<HTMLElement>(".msg")!;
      check(msg.clientHeight < msg.scrollHeight, "the rest is hidden");
    }
  });
  await clear();
  const long = lines(200);
  for (let i = 0; i < 4; i++) notify({ message: `${i}\n${long}`, sticky: true, key: `long-${i}` });
  await frame();
  await frame();
  for (const t of toasts()) press(button(t)!);
  await frame();
  await frame();
  run("ADR 0111 I5, I6: four open 200-line notifications keep the stack in the window and every × reachable", () => {
    check(inWindow(stack().getBoundingClientRect()), "stack in the window");
    check(stack().classList.contains("scroll"), "the stack scrolls");
    for (const t of toasts()) {
      check(button(t)?.textContent === "折りたたむ", "open");
      check(t.getBoundingClientRect().height <= stack().clientHeight, "a notification fits the stack");
      check(closeReachable(t), "its × shows when its top is scrolled in");
      const msg = t.querySelector<HTMLElement>(".msg")!;
      check(msg.scrollHeight > msg.clientHeight, "the open text scrolls inside");
    }
  });
  await clear();
  notify({ message: long, sticky: true });
  await frame();
  await frame();
  press(button(toasts()[0])!);
  await frame();
  run("ADR 0111 I5, I6: one open 200-line notification stays in the window with its × inside", () => {
    const t = toasts()[0];
    check(inWindow(stack().getBoundingClientRect()), "stack in the window");
    check(inWindow(t.querySelector<HTMLElement>("[data-x]")!.getBoundingClientRect()), "× in the window");
  });
  await clear();
};

const report = (ok: boolean, error?: unknown) => {
  const result = { ok, height: innerHeight, results: [...results], ...(error ? { error: String(error) } : {}) };
  document.querySelector("#result")!.textContent = JSON.stringify(result, null, 1);
  (window as unknown as { noticeFoldResult: unknown }).noticeFoldResult = result;
};
const start = () => main().then(() => report(true), (error) => report(false, error));
(window as unknown as { noticeFoldRun: () => Promise<void> }).noticeFoldRun = start;
void start();
