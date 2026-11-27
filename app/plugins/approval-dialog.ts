import { esc } from "../esc.ts";

export type PluginApprovalPrompt = { id: string; name: string; path: string; action: string };
export type PluginApprovalDecision = PluginApprovalPrompt & { allowed: boolean };

type Answer = (allow: boolean) => Promise<void>;

/** Display the head of Rust's approval queue. Replacing it does not answer it. */
export const createApprovalPrompts = (
  read: () => Promise<PluginApprovalPrompt | null>,
  reply: (id: string, allow: boolean) => Promise<void>,
  show: (prompt: PluginApprovalPrompt, answer: Answer) => () => void,
) => {
  let visible: { id: string; close: () => void } | undefined;
  let generation = 0;

  const sync = async () => {
    const reading = ++generation;
    const prompt = await read();
    if (reading !== generation || visible?.id === prompt?.id) return;
    visible?.close();
    visible = undefined;
    if (!prompt) return;
    const close = show(prompt, async (allow) => {
      if (visible?.id !== prompt.id) return;
      await reply(prompt.id, allow);
      await sync();
    });
    visible = { id: prompt.id, close };
  };
  return sync;
};

export const showApprovalDialog = (prompt: PluginApprovalPrompt, answer: Answer, fail: (error: unknown) => void) => {
  const previous = document.activeElement as HTMLElement | null;
  const dim = document.createElement("div");
  dim.className = "dim plugin-approval";
  dim.innerHTML = `<div class="dialog small choice" role="alertdialog" aria-labelledby="plugin-approval-title" aria-describedby="plugin-approval-details">
    <div class="mtitle" id="plugin-approval-title">プラグインの権限の承認</div>
    <div class="mmsg" id="plugin-approval-details">${esc(prompt.name)} が「${esc(prompt.action)}」権限を求めています。<br>対象：${esc(prompt.path)}<br>期限：Aleph を終了するまで</div>
    <div class="mbuttons">
      <button type="button" class="btn" data-approval-deny>許可しない</button>
      <button type="button" class="btn pri" data-approval-allow>許可する</button>
    </div>
  </div>`;
  const deny = dim.querySelector<HTMLButtonElement>("[data-approval-deny]")!;
  const allow = dim.querySelector<HTMLButtonElement>("[data-approval-allow]")!;
  let submitting = false;
  const choose = (allowed: boolean) => {
    if (submitting) return;
    submitting = true;
    void answer(allowed).catch((error) => {
      submitting = false;
      fail(error);
    });
  };
  deny.addEventListener("click", () => choose(false));
  allow.addEventListener("click", () => choose(true));
  dim.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      choose(false);
    } else if (e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      (document.activeElement === deny ? allow : deny).focus();
    } else if (e.key === "Enter" || e.key === " ") {
      e.stopPropagation();
    }
  });
  document.body.append(dim);
  deny.focus();
  return () => {
    const restore = dim.contains(document.activeElement);
    dim.remove();
    if (restore) previous?.focus();
  };
};
