// A screen for recording input events in the Tauri WebView (docs/adr/0019):
// the editor with a short text, and the events it sees (keydown, beforeinput,
// input, composition, the selection) written out as JSON in the shape the
// replay tests read (app/ed/fixtures/*.json).
import { api } from "../api.ts";
import { esc } from "../esc.ts";
import { onPress } from "../ui/dom.ts";
import type { Recorded, RecordedEvent } from "./control.ts";
import { createEditor } from "./editor.ts";

const LOG_FILE = "/tmp/aleph-ime-log.json";
const SAMPLE = "灯台の灯が、\n冬の海を照らしていた。\n\n霧笛が鳴る。";

/** The text the DOM shows in the editor's lines, gutters and marks left out. */
const domText = (content: HTMLElement): string => {
  const lines: string[] = [];
  const text = (n: Node): string => {
    if (n instanceof HTMLElement && (n.contentEditable === "false" || n.classList.contains("ed-gut"))) return "";
    if (n.nodeType === 3) return n.nodeValue ?? "";
    return [...n.childNodes].map(text).join("");
  };
  for (const c of content.children) if (!c.classList.contains("ed-gap") && !c.classList.contains("page-break")) lines.push(text(c));
  return lines.join("\n");
};

export const startRecorder = (root: HTMLElement) => {
  document.title = "IME の記録";
  root.innerHTML = `<div class="recorder">
  <div class="rec-head">
    <span class="btn" data-mode="h">横書き</span><span class="btn" data-mode="v">縦書き</span><span class="btn" data-a="inv">不可視文字</span>
    <input class="field" data-k="name" placeholder="試料の名前（例：途中で変換して確定）">
    <span class="btn" data-a="reset">始めから</span><span class="btn pri" data-a="copy">JSON を書き出す</span>
    <span class="rec-state"></span>
  </div>
  <div class="rec-dom"></div>
  <div class="rec-ed"></div>
  <pre class="rec-log"></pre>
</div>`;
  const host = root.querySelector<HTMLElement>(".rec-ed")!;
  const log = root.querySelector<HTMLElement>(".rec-log")!;
  const state = root.querySelector<HTMLElement>(".rec-state")!;
  let events: RecordedEvent[] = [];
  let initial = SAMPLE;
  let vertical = false;
  let lastSel = "";
  let composing = false;
  let invisibles = false;

  const ed = createEditor({
    parent: host,
    kind: "gm",
    text: SAMPLE,
    grid: { chars: 30, lines: 10, vertical: false },
    chars: 30,
    invisibles: false,
    vertical,
    style: "prose",
    base: async () => null,
    onChange: () => {},
    onSave: () => {},
  });
  const t = ed.edit!;
  const content = t.view.content;

  const push = (e: RecordedEvent) => {
    events.push(e);
    log.textContent = events.map((x) => JSON.stringify(x)).join("\n");
    log.scrollTop = log.scrollHeight;
    const dom = domText(content);
    const same = dom === t.core.text();
    state.innerHTML = composing ? "変換中" : same ? "DOM と文書は一致" : `<b>DOM と文書が食い違う</b>：${esc(JSON.stringify(dom))}`;
  };
  const sel = () => {
    if (composing) return;
    const s = t.core.sel();
    const k = `${s.anchor}:${s.head}`;
    if (k === lastSel) return;
    lastSel = k;
    push({ type: "select", anchor: s.anchor, head: s.head });
  };
  sel();

  // in the capture phase, before the editor handles each event; the selection after
  const on = <K extends keyof HTMLElementEventMap>(k: K, f: (e: HTMLElementEventMap[K]) => void) => {
    content.addEventListener(k, (e) => (sel(), f(e)), true);
    content.addEventListener(k, () => queueMicrotask(sel));
  };
  on("keydown", (e) => push({ type: "keydown", key: e.key, keyCode: e.keyCode, isComposing: e.isComposing }));
  on("beforeinput", (e) => push({ type: "beforeinput", inputType: e.inputType, data: e.data, isComposing: e.isComposing }));
  on("input", (e) => push({ type: "input", inputType: (e as InputEvent).inputType, data: (e as InputEvent).data }));
  on("compositionstart", () => {
    push({ type: "compositionstart" });
    composing = true;
  });
  on("compositionupdate", (e) => push({ type: "compositionupdate", data: e.data }));
  on("compositionend", (e) => {
    push({ type: "compositionend", data: e.data, dom: domText(content) });
    composing = false;
  });
  content.addEventListener(
    "blur",
    () => {
      if (composing) push({ type: "blur", dom: domText(content) });
      composing = false;
    },
    true,
  );
  document.addEventListener("selectionchange", () => queueMicrotask(sel));
  // the selection as the DOM has it, to compare with the editor's
  const where = (n: Node | null, o: number) => {
    if (!n) return "-";
    const e = n.nodeType === 3 ? n.parentElement : (n as HTMLElement);
    return `${n.nodeType === 3 ? `text(${JSON.stringify(n.nodeValue)})` : (n as HTMLElement).tagName}@${o} in .${e?.className ?? ""}`;
  };
  const domSel = root.querySelector<HTMLElement>(".rec-dom")!;
  document.addEventListener("selectionchange", () => {
    const s = document.getSelection();
    domSel.textContent = s ? `DOM: ${where(s.anchorNode, s.anchorOffset)} → ${where(s.focusNode, s.focusOffset)} / 文書: ${t.core.sel().anchor} → ${t.core.sel().head}` : "";
  });

  const reset = () => {
    initial = t.core.text();
    events = [];
    lastSel = "";
    log.textContent = "";
    sel();
    ed.focus();
  };

  // presses are taken at mouseup: in these windows mousedown can arrive after mouseup (as in the title bar)
  onPress(root.querySelector<HTMLElement>(".rec-head")!, async (e) => {
    const el = e.target as HTMLElement;
    const mode = el.closest<HTMLElement>("[data-mode]")?.dataset.mode;
    if (mode) {
      vertical = mode === "v";
      ed.setVertical(vertical);
      return ed.focus();
    }
    const a = el.closest<HTMLElement>("[data-a]")?.dataset.a;
    if (a === "reset") reset();
    if (a === "inv") {
      invisibles = !invisibles;
      ed.setInvisibles(invisibles);
      ed.focus();
    }
    if (a === "copy") {
      const rec: Recorded = {
        name: root.querySelector<HTMLInputElement>("[data-k=name]")!.value || "untitled",
        ua: navigator.userAgent,
        note: vertical ? "vertical" : "horizontal",
        initial,
        events,
        expected: t.core.text(),
        caret: t.core.sel().head,
      };
      const json = JSON.stringify(rec, null, 2);
      // the clipboard may be refused in the WebView; the file is always written
      try {
        await api.writeText(LOG_FILE, json);
        state.textContent = `${LOG_FILE} に書きました`;
      } catch (err) {
        state.textContent = `書けません：${String(err)}`;
      }
      void navigator.clipboard?.writeText(json).catch(() => {});
    }
  });
  ed.focus();
};
