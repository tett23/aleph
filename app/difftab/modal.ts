// The modal dialogs before the assistant's edit is applied (docs/adr/0088): while one is shown, the
// state's modal flag is up (the keys run no command, the palette does not open), the other children
// of body are inert, and the focus stays among its buttons. Other dialogs stay as they are.
import { esc } from "../esc.ts";
import type { Store } from "../store.ts";
import { swallowLatePress } from "../ui/press.ts";

type Inertable = { inert: boolean };
type Focusable = { focus: () => void };

/** What holdModal touches of the document: body's children, appending to body, and the focused element. */
export type ModalHost = { children: () => Inertable[]; append: (el: Inertable) => void; active: () => Focusable | null };

/**
 * Shows `dim` as a modal: the other children of body made inert (those already inert are left alone),
 * the flag raised, the focus on `initial`. The returned function takes back only the inert it set,
 * removes `dim`, lowers the flag and gives the focus back to where it was.
 */
export const holdModal = (host: ModalHost, dim: Inertable & { remove: () => void }, initial: Focusable, setModal: (on: boolean) => void): (() => void) => {
  const back = host.active();
  const marked = host.children().filter((c) => c !== dim && !c.inert);
  for (const c of marked) c.inert = true;
  host.append(dim);
  setModal(true);
  initial.focus();
  return () => {
    for (const c of marked) c.inert = false;
    dim.remove();
    setModal(false);
    back?.focus();
  };
};

/** A key in the dialog: Tab and Shift-Tab go round the buttons, Enter presses the focused one, Esc cancels. */
export const modalKey = (key: string, shift: boolean, at: number, count: number): { focus: number } | { press: number } | { cancel: true } | null => {
  if (key === "Tab") return { focus: (at + (shift ? -1 : 1) + count) % count };
  if (key === "Enter") return { press: at };
  if (key === "Escape") return { cancel: true };
  return null;
};

export type ModalButton<T> = { label: string; value: T; primary?: boolean };

/** A modal dialog: resolves to the pressed button's value, or `cancel` for Esc and a press outside it. */
export const modalDialog = <T>(store: Pick<Store, "dispatch">, o: { title: string; message: string[]; buttons: ModalButton<T>[]; cancel: T }): Promise<T> =>
  new Promise((resolve) => {
    const t = document.createElement("template");
    t.innerHTML = `<div class="dim pre-apply"><div class="dialog small choice" role="alertdialog" aria-modal="true"><div class="mtitle">${esc(o.title)}</div>${o.message
      .map((m) => `<div class="mmsg">${esc(m)}</div>`)
      .join("")}<div class="mbuttons">${o.buttons.map((b, i) => `<button type="button" class="btn${b.primary ? " pri" : ""}" data-i="${i}">${esc(b.label)}</button>`).join("")}</div></div></div>`;
    const dim = t.content.firstElementChild as HTMLElement;
    const buttons = [...dim.querySelectorAll<HTMLButtonElement>("button")];
    const primary = Math.max(0, o.buttons.findIndex((b) => b.primary));
    let release = () => {};
    let done = false;
    const finish = (v: T) => {
      if (done) return;
      done = true;
      release();
      swallowLatePress();
      resolve(v);
    };
    // taken at mouseup, as the other dialogs: in this window a click was seen not to arrive on the first press
    dim.addEventListener("mouseup", (e) => {
      if (e.button !== 0) return;
      const el = e.target as HTMLElement;
      if (el === dim) return finish(o.cancel);
      const i = el.closest<HTMLElement>("[data-i]")?.dataset.i;
      if (i !== undefined) finish(o.buttons[Number(i)].value);
    });
    dim.addEventListener("keydown", (e) => {
      if (e.isComposing) return;
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const k = modalKey(e.key, e.shiftKey, at < 0 ? primary : at, buttons.length);
      if (!k) return;
      e.preventDefault();
      e.stopPropagation();
      if ("focus" in k) buttons[k.focus].focus();
      else if ("press" in k) finish(o.buttons[k.press].value);
      else finish(o.cancel);
    });
    release = holdModal(
      { children: () => [...document.body.children] as HTMLElement[], append: (el) => document.body.append(el as HTMLElement), active: () => document.activeElement as HTMLElement | null },
      dim,
      buttons[primary],
      (on) => store.dispatch({ type: "modal", on }),
    );
  });

/** Before applying, with changes not committed: "cancel", "apply" (without committing), or "commit" (then apply). */
export const commitBeforeApplyDialog = (store: Pick<Store, "dispatch">) =>
  modalDialog<"cancel" | "apply" | "commit">(store, {
    title: "適用する前に、コミットしますか？",
    message: [
      "このワークスペースには、コミットしていない変更があります。",
      "アシスタントの書き換えは、正しくないことや、原稿を壊すことがあります。",
      "コミットしておくと、書き換えの分だけを差分のタブで見て、Git で戻せます。",
    ],
    buttons: [
      { label: "やめる", value: "cancel" },
      { label: "コミットせずに適用", value: "apply" },
      { label: "コミットして適用", value: "commit", primary: true },
    ],
    cancel: "cancel",
  });

/** Before applying, where Git cannot undo the edit: "cancel" or "apply". */
export const irreversibleApplyDialog = (store: Pick<Store, "dispatch">) =>
  modalDialog<"cancel" | "apply">(store, {
    title: "このワークスペースでは、書き換えを Git で戻せません",
    message: ["適用した書き換えは、取り消し（⌘Z）のほかに戻す方法がありません。"],
    buttons: [
      { label: "やめる", value: "cancel" },
      { label: "適用", value: "apply", primary: true },
    ],
    cancel: "cancel",
  });
