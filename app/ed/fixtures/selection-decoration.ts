// Run this page in WebKit. It exercises the editor's real rendering and selection.
import { domWalk, offsetToDom } from "../dompos.ts";
import { createEditor, type EditorOptions } from "../editor.ts";

const host = document.querySelector<HTMLElement>("#fixture")!;
const result = document.querySelector<HTMLElement>("#result")!;
const settle = () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
const check = (value: unknown, message: string): void => {
  if (!value) throw new Error(message);
};
const snapshot = (el: Element) => {
  const r = el.getBoundingClientRect();
  return [r.x, r.y, r.width, r.height];
};
const equalGeometry = (before: number[], after: number[], label: string) =>
  check(before.length === after.length && before.every((v, i) => Math.abs(v - after[i]) <= 1 / 64), label);
const at = (line: HTMLElement, offset: number) => offsetToDom(domWalk, line, offset)!;
const marks = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(".ed-selection-decoration .ed-selmatch")];
const selectByDOM = (line: HTMLElement, from: number, to: number) => {
  const a = at(line, from);
  const b = at(line, to);
  document.getSelection()!.setBaseAndExtent(a.node, a.offset, b.node, b.offset);
  // Process this selection now so geometry is taken on both sides of a single update.
  document.dispatchEvent(new Event("selectionchange"));
};

const stableSelection = async (vertical: boolean, dark: boolean) => {
  document.body.classList.toggle("theme-dark", dark);
  const text = "猫と猫 office office、、がが　　猫";
  const editor = createEditor({
    parent: host, kind: "txt", text, chars: 12, vertical, invisibles: false, style: "prose",
    grid: { chars: 12, lines: 20, vertical }, base: async () => false, onChange() {}, onSave() {},
  });
  try {
    const { view, core } = editor.edit!;
    const scroller = view.root.querySelector<HTMLElement>(".ed-scroll")!;
    const lineAt = () => view.content.querySelector<HTMLElement>(".ed-line")!;
    editor.focus();
    await settle();
    selectByDOM(lineAt(), 0, 0);
    const line = lineAt();
    const textNodes = [...line.childNodes];
    const geometry = () => [
      ...snapshot(view.root), ...snapshot(lineAt()),
      scroller.scrollWidth, scroller.scrollHeight, scroller.scrollLeft, scroller.scrollTop,
      ...Array.from({ length: text.length }, (_, i) => {
        const range = new Range();
        const a = at(lineAt(), i);
        const b = at(lineAt(), i + 1);
        range.setStart(a.node, a.offset);
        range.setEnd(b.node, b.offset);
        const rect = range.getBoundingClientRect();
        return [rect.x, rect.y, rect.width, rect.height];
      }).flat(),
    ];
    const initial = geometry();
    const observer = new MutationObserver(() => {});
    observer.observe(view.content, { childList: true, attributes: true, subtree: true, characterData: true });
    try {
      const checkSelection = (from: number, to: number, expected: boolean) => {
        selectByDOM(lineAt(), from, to);
        check(line === lineAt(), "ADR 0102 I3: changing selection matches exchanged the line DOM");
        check(textNodes.every((node, i) => node === line.childNodes[i]), "ADR 0102 I3: changing selection matches exchanged inline nodes");
        check(!observer.takeRecords().length, "ADR 0102 I3: selection highlighting wrote to the editable DOM or virtual gaps");
        equalGeometry(initial, geometry(), "ADR 0102 I1: selection highlighting changed layout or scroll");
        check(core.sel().anchor === from && core.sel().head === to, "ADR 0102 I2: selection direction or endpoints changed");
        check(document.activeElement === view.content, "ADR 0102 I2: focus changed");
        check(!!marks(view.root).length === expected, "ADR 0102 I1: different decorations were not drawn");
      };
      for (let i = 0; i < 100; i++) {
        checkSelection(1, 0, true);
        checkSelection(0, 0, false);
      }
      const word = text.indexOf("ffi");
      const punctuation = text.indexOf("、");
      const combined = text.indexOf("が");
      const blank = text.indexOf("　");
      checkSelection(word, word + 3, true);
      checkSelection(punctuation, punctuation + 1, true);
      checkSelection(combined, combined + 2, true);
      checkSelection(blank, blank + 1, true);
      checkSelection(text.length - 1, text.length, true);
      checkSelection(1, 2, false);
    } finally {
      observer.disconnect();
    }
  } finally {
    editor.destroy();
  }
};

const virtualizedMatches = async (vertical: boolean) => {
  const text = ["猫", ...Array.from({ length: 240 }, () => "aaaa"), "猫"].join("\n");
  const options: EditorOptions = {
    parent: host, kind: "txt", text, chars: 14, vertical, invisibles: false, style: "prose",
    grid: { chars: 14, lines: 20, vertical }, base: async () => false, onChange() {}, onSave() {},
  };
  const editor = createEditor(options);
  try {
    const { view, core } = editor.edit!;
    const first = view.content.querySelector<HTMLElement>('.ed-line[data-line="1"]')!;
    editor.focus();
    selectByDOM(first, 0, 1);
    check(!marks(view.root).length, "ADR 0102 I4: an offscreen match was drawn");
    const tail = text.length - 1;
    view.scrollToPos(tail, true);
    await settle();
    check(marks(view.root).length === 1, "ADR 0102 I4: the visible match has no mark");
    host.style.width = "520px";
    host.style.height = "300px";
    await settle();
    const after = marks(view.root)[0];
    const last = view.content.querySelector<HTMLElement>('.ed-line[data-line="242"]')!;
    const start = at(last, 0);
    const end = at(last, 1);
    const range = new Range();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    const rect = range.getBoundingClientRect();
    check(after, "ADR 0102 I4: the visible match disappeared after resizing");
    equalGeometry([rect.x, rect.y, rect.width, rect.height], snapshot(after), "ADR 0102 I4: the mark no longer aligns with the matched text after resizing");
    core.apply([{ from: tail, to: tail + 1, insert: "犬" }], "edit");
    check(!marks(view.root).length, "ADR 0102 I4: the old match remained after editing");
    view.setVertical(!vertical);
    check(!marks(view.root).length, "ADR 0102 I4: the old match returned after rotating the sheet");
  } finally {
    editor.destroy();
    host.style.removeProperty("width");
    host.style.removeProperty("height");
  }
};

const lineBreaksAndComposition = async () => {
  const text = "猫\n犬\n猫\n犬\n";
  const editor = createEditor({
    parent: host, kind: "txt", text, chars: 14, vertical: false, invisibles: false, style: "prose",
    grid: { chars: 14, lines: 20, vertical: false }, base: async () => false, onChange() {}, onSave() {},
  });
  try {
    const { view, core } = editor.edit!;
    editor.focus();
    const line = (n: number) => view.content.querySelector<HTMLElement>(`.ed-line[data-line="${n}"]`)!;
    const selection = document.getSelection()!;
    const first = at(line(1), 1);
    const second = at(line(2), 0);
    selection.setBaseAndExtent(first.node, first.offset, second.node, second.offset);
    document.dispatchEvent(new Event("selectionchange"));
    await settle();
    check(core.selectedText() === "\n", `ADR 0102 I1: newline selection failed ${JSON.stringify(core.sel())} ${JSON.stringify(selection.toString())}`);
    check(marks(view.root).length === 3, `ADR 0102 I4: got ${marks(view.root).length} of three newline-only matches`);
    const original = JSON.stringify(marks(view.root).map(snapshot));
    view.content.dispatchEvent(new CompositionEvent("compositionstart"));
    check(view.composing(), "ADR 0102 I2: composition did not start");
    const a = selection.anchorNode;
    const b = selection.focusNode;
    core.setLayer("selmatch", []);
    view.selectionMatchesChanged();
    check(JSON.stringify(marks(view.root).map(snapshot)) === original, "ADR 0102 I2: decoration changed while composing");
    check(view.composing() && selection.anchorNode === a && selection.focusNode === b, "ADR 0102 I2: composition or its selection changed");
    view.content.dispatchEvent(new CompositionEvent("compositionend"));
    await settle();
    check(!view.composing() && !marks(view.root).length, "ADR 0102 I2, I4: decoration did not refresh after composition");
  } finally {
    editor.destroy();
  }
};

const sharedScroller = async () => {
  host.classList.add("multi");
  const options: EditorOptions = {
    parent: host, scroller: host, kind: "txt", text: "猫 猫",
    chars: 14, vertical: false, invisibles: false, style: "prose",
    grid: { chars: 14, lines: 20, vertical: false }, base: async () => false, onChange() {}, onSave() {},
  };
  const first = createEditor(options);
  const second = createEditor({ ...options, text: "猫 犬" });
  try {
    const a = first.edit!.view;
    const b = second.edit!.view;
    first.focus();
    await settle();
    const before = [host.scrollWidth, host.scrollHeight, host.scrollLeft, host.scrollTop, ...snapshot(b.root)];
    selectByDOM(a.content.querySelector<HTMLElement>(".ed-line")!, 0, 1);
    check(marks(a.root).length === 1 && !marks(b.root).length, "ADR 0102 I4: a match escaped its editor");
    equalGeometry(before, [host.scrollWidth, host.scrollHeight, host.scrollLeft, host.scrollTop, ...snapshot(b.root)], "ADR 0102 I1, I2: shared scroller moved");
  } finally {
    first.destroy();
    second.destroy();
    host.classList.remove("multi");
  }
};

const maximumMatches = async () => {
  const editor = createEditor({
    parent: host, kind: "txt", text: "猫\n".repeat(10002), chars: 14, vertical: false, invisibles: false, style: "prose",
    grid: { chars: 14, lines: 20, vertical: false }, base: async () => false, onChange() {}, onSave() {},
  });
  try {
    const { view, core } = editor.edit!;
    editor.focus();
    await settle();
    const line = view.content.querySelector<HTMLElement>(".ed-line")!;
    const scroller = view.root.querySelector<HTMLElement>(".ed-scroll")!;
    const before = [scroller.scrollWidth, scroller.scrollHeight];
    selectByDOM(line, 0, 1);
    check(core.layer("selmatch").length === 10000, "ADR 0102 I1, I4: the occurrence cap changed");
    check(marks(view.root).length > 0 && marks(view.root).length < 10000, "ADR 0102 I4: only the matches in view should be drawn");
    equalGeometry(before, [scroller.scrollWidth, scroller.scrollHeight], "ADR 0102 I1: the matches changed scrollable dimensions");
  } finally {
    editor.destroy();
  }
};

void (async () => {
  try {
    await document.fonts.ready;
    for (const vertical of [false, true]) for (const dark of [false, true]) await stableSelection(vertical, dark);
    for (const vertical of [false, true]) await virtualizedMatches(vertical);
    await lineBreaksAndComposition();
    await sharedScroller();
    await maximumMatches();
    result.textContent = JSON.stringify({ ok: true, checks: "ADR 0102 I1, I2, I3, I4", cycles: 400 });
  } catch (error) {
    result.textContent = JSON.stringify({ ok: false, error: String(error) });
  }
  const engine = (globalThis as { webkit?: { messageHandlers?: { report?: { postMessage: (v: string) => void } } } }).webkit;
  engine?.messageHandlers?.report?.postMessage(result.textContent);
})();
