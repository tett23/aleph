// What floats over the editor (docs/adr/0019): the hover and completion popups,
// the search panel and the list of diagnostics. They are written horizontally
// in both writing modes, placed by the client rectangles of the text.
import { esc } from "../esc.ts";
import type { CompletionItem } from "./editor.ts";

/** The element floating panels go into: the editor pane, so they stay put while the text scrolls. */
export const panelHost = (root: HTMLElement): HTMLElement => root.closest<HTMLElement>(".main-pane") ?? document.body;

/** A popup at a rectangle of the text: below it in horizontal writing, left of it in vertical. */
export const popup = (cls: string, at: DOMRect, vertical: boolean, html: string): HTMLElement => {
  const p = document.createElement("div");
  p.className = `ed-popup ${cls}`;
  p.innerHTML = html;
  document.body.append(p);
  const w = p.offsetWidth;
  const h = p.offsetHeight;
  let left = vertical ? at.left - w - 6 : at.left;
  let top = vertical ? at.top : at.bottom + 4;
  if (!vertical && top + h > innerHeight - 8) top = Math.max(8, at.top - h - 4);
  if (vertical && left < 8) left = at.right + 6;
  left = Math.max(8, Math.min(left, innerWidth - w - 8));
  top = Math.max(8, Math.min(top, innerHeight - h - 8));
  Object.assign(p.style, { left: `${left}px`, top: `${top}px` });
  return p;
};

// ---- completion ----

export const createCompletionList = (at: DOMRect, vertical: boolean, items: CompletionItem[], onPick: (i: CompletionItem) => void) => {
  let sel = 0;
  const p = popup("ed-complete", at, vertical, `<ul>${items.map((i, k) => `<li data-k="${k}"><span>${esc(i.label)}</span>${i.detail ? `<small>${esc(i.detail)}</small>` : ""}</li>`).join("")}</ul>`);
  const mark = () => p.querySelectorAll("li").forEach((li, k) => li.toggleAttribute("aria-selected", k === sel));
  mark();
  p.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const k = (e.target as HTMLElement).closest<HTMLElement>("li")?.dataset.k;
    if (k !== undefined) onPick(items[Number(k)]);
  });
  return {
    /** Keys while the list is open; returns true when taken. */
    key: (e: KeyboardEvent): boolean => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        sel = (sel + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
        mark();
        p.querySelector("li[aria-selected]")?.scrollIntoView({ block: "nearest" });
        return true;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        onPick(items[sel]);
        return true;
      }
      return false;
    },
    close: () => p.remove(),
  };
};

// ---- the search panel ----

export type SearchUi = {
  el: HTMLElement;
  query: () => { search: string; replace: string; regexp: boolean; caseSensitive: boolean };
  setCount: (current: number, total: number) => void;
  focus: (select?: string) => void;
  close: () => void;
};

export const createSearchPanel = (
  host: HTMLElement,
  on: { change: () => void; next: (dir: 1 | -1) => void; replace: () => void; replaceAll: () => void; close: () => void },
): SearchUi => {
  host.querySelector(":scope > .ed-search")?.remove();
  const el = document.createElement("div");
  el.className = "ed-panel ed-search";
  el.innerHTML = `<input class="field" data-s="find" placeholder="検索" spellcheck="false"><span class="ed-count"></span>
<span class="btn" data-a="prev" title="前へ（⇧Enter）">↑</span><span class="btn" data-a="next" title="次へ（Enter）">↓</span>
<label title="大文字と小文字を区別する"><input type="checkbox" data-s="case">Aa</label><label title="正規表現"><input type="checkbox" data-s="re">.*</label>
<input class="field" data-s="replace" placeholder="置換" spellcheck="false"><span class="btn" data-a="replace">置換</span><span class="btn" data-a="all">すべて置換</span>
<span class="btn" data-a="close" title="閉じる（Esc）">×</span>`;
  host.append(el);
  const $ = (k: string) => el.querySelector<HTMLInputElement>(`[data-s="${k}"]`)!;
  el.addEventListener("input", () => on.change());
  el.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>("[data-a]")?.dataset.a;
    if (a === "prev" || a === "next") on.next(a === "next" ? 1 : -1);
    else if (a === "replace") on.replace();
    else if (a === "all") on.replaceAll();
    else if (a === "close") on.close();
  });
  el.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      on.close();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if ((e.target as HTMLElement).dataset.s === "replace") on.replace();
      else on.next(e.shiftKey ? -1 : 1);
    }
  });
  return {
    el,
    query: () => ({ search: $("find").value, replace: $("replace").value, regexp: $("re").checked, caseSensitive: $("case").checked }),
    setCount: (current, total) => {
      el.querySelector(".ed-count")!.textContent = $("find").value ? (total ? `${current} / ${total}` : "なし") : "";
    },
    focus: (select) => {
      if (select !== undefined) $("find").value = select;
      $("find").focus();
      $("find").select();
    },
    close: () => el.remove(),
  };
};
