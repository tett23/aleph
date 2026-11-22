import type { Ctx } from "./ctx.ts";
import { holdModal, modalKey } from "./difftab/modal.ts";
import { esc } from "./esc.ts";
import { gitFailure, gitOperation, globalIdentity, saveGlobalIdentity, type GitLogin, type GitIdentity, type IdentityKey, type IdentityValue } from "./git-ipc.ts";
import { identityInputValid, validIdentity } from "./git-workflow.ts";
import { h, icon } from "./icons.ts";
import { basename } from "./path.ts";
import { item, openSettingsDialog } from "./ui/settings.ts";

const keys = ["name", "email"] as const;
const labels = { name: "名前", email: "メールアドレス" };
const source = (v: IdentityValue | null) => v ? `${esc(v.value)}（${esc(v.source)}）` : "未設定";
const nameField = "input[data-identity=name]";
const loading = "Git 設定を読み込んでいます…";

const identityForm = (el: HTMLElement, state: GitIdentity, save: (values: { target: string; name: string; email: string }) => Promise<GitIdentity>, local: boolean) => {
  const input = (key: IdentityKey) => `<input class="field" aria-label="${labels[key]}" type="text" data-identity="${key}" value="${esc(state.local[key] ?? "")}">`;
  const fields = keys.map((key) => item(labels[key], `有効値 ${source(state.effective[key])}${local ? `<br>継承値 ${source(state.inherited[key])}` : ""}`, input(key))).join("");
  el.innerHTML = `<p class="muted">${local
    ? "同じリポジトリ内のほかのプロジェクトにも適用されます。空欄にした項目は継承します。" + (state.repository?.linked ? "同じリポジトリのほかの worktree にも適用されます。" : "")
    : "全リポジトリの既定値です。ここで設定すると、リポジトリごとの入力を省けます。リポジトリ内の設定がある場合は、そちらが優先されます"}</p>
    ${local && state.repository ? item("リポジトリ", esc(state.repository.root), "") : ""}
    ${item("保存先", esc(state.target) + (state.exists ? "" : "<br>設定ファイルがありません。保存時に作成します。"), "")}
    ${fields}
    <div class="git-identity-actions">
      <button type="button" class="btn pri" data-save disabled>${local ? "このリポジトリに保存" : "グローバルに保存"}</button>
      ${local ? `<button type="button" class="btn" data-inherit disabled>グローバル設定を使う</button>` : ""}
    </div>
    <p class="muted" role="status" data-git-note></p>`;
  const field = (key: IdentityKey) => el.querySelector<HTMLInputElement>(`[data-identity=${key}]`)!;
  const button = el.querySelector<HTMLButtonElement>("[data-save]")!;
  const inherit = el.querySelector<HTMLButtonElement>("[data-inherit]");
  const note = el.querySelector<HTMLElement>("[data-git-note]")!;
  const inherited = local ? state.inherited : undefined;
  const canInherit = !!local && identityInputValid("", "", inherited);
  let busy = false;
  const values = () => ({ target: state.target, name: field("name").value, email: field("email").value });
  const update = () => {
    const { name, email } = values();
    button.disabled = busy || !identityInputValid(name, email, inherited);
    if (inherit) inherit.disabled = busy || !canInherit;
  };
  if (local && !canInherit) note.textContent = `グローバル設定で不足している項目は ${keys.filter((key) => !validIdentity(state.inherited[key]?.value ?? "")).map((key) => labels[key]).join("、")}`;
  const submit = async (useInherited: boolean) => {
    if (busy) return;
    busy = true;
    update();
    try {
      const next = await save(useInherited ? { target: state.target, name: "", email: "" } : values());
      if (!el.isConnected) return;
      identityForm(el, next, save, local);
      el.querySelector<HTMLElement>("[data-git-note]")!.textContent = "保存しました";
      el.querySelector<HTMLElement>(nameField)?.focus();
    } catch (failure) {
      note.textContent = gitFailure(failure).message;
    } finally {
      busy = false;
      update();
    }
  };
  el.oninput = update;
  button.onclick = () => void submit(false);
  if (inherit) inherit.onclick = () => void submit(true);
  update();
};

const loadIdentity = async (el: HTMLElement, read: () => Promise<GitIdentity | null>, fill: (state: GitIdentity) => void) => {
  try {
    const state = await read();
    if (!el.isConnected) return;
    if (state) {
      fill(state);
      el.querySelector<HTMLElement>(nameField)?.focus();
    } else {
      el.textContent = "この場所は Git のリポジトリではありません。Git パネルから初期化できます。";
    }
  } catch (failure) {
    el.textContent = gitFailure(failure).message;
  }
};

export const mountGitSettings = (ctx: Ctx) => ctx.settings.push({
  id: "git",
  label: "Git",
  group: "オプション",
  render: () => `<div data-global-identity>${loading}</div>`,
  mount: (section) => {
    const form = section.querySelector<HTMLElement>("[data-global-identity]")!;
    void loadIdentity(form, globalIdentity, (state) => identityForm(form, state, saveGlobalIdentity, false));
  },
});

const modal = (ctx: Ctx, html: string, initial: string, cancel: () => void, opener = document.activeElement as HTMLElement | null) => {
  const element = h(`<div class="dim git-modal">${html}</div>`);
  const close = holdModal(
    { children: () => [...document.body.children] as HTMLElement[], append: (el) => document.body.append(el as HTMLElement), active: () => opener },
    element,
    element.querySelector<HTMLElement>(initial)!,
    (on) => ctx.store.dispatch({ type: "modal", on }),
  );
  element.onkeydown = (e) => {
    if (e.isComposing) return;
    if (e.key === "Escape") {
      e.stopPropagation();
      e.preventDefault();
      cancel();
    } else if (e.key === "Tab") {
      const controls = [...element.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), a[href]")];
      const result = modalKey(e.key, e.shiftKey, controls.indexOf(document.activeElement as HTMLElement), controls.length);
      if (result && "focus" in result) {
        e.preventDefault();
        controls[result.focus]?.focus();
      }
    }
  };
  return { element, close };
};

export const openRepositorySettings = (ctx: Ctx, cwd: string, project?: string, opener?: HTMLElement) => {
  const title = project ? "プロジェクト設定" : "リポジトリ設定";
  const { element, close } = modal(ctx, `<div class="dialog" role="dialog" aria-modal="true" aria-label="${title}">
    <div class="mnav"><div class="on">Git</div></div>
    <div class="mbody"><button type="button" class="iconbtn close" aria-label="閉じる" data-dismiss>${icon("x")}</button>
      <div class="mhead"><h2>${title}</h2></div>
      <div class="msec">${project ? `<p>${esc(basename(project))}（${esc(project)}）</p>` : ""}
      <div data-identity-form>${loading}</div></div>
    </div></div>`, "[data-dismiss]", () => close(), opener);
  element.onclick = (e) => { if (e.target === element || (e.target as Element).closest("[data-dismiss]")) close(); };
  const form = element.querySelector<HTMLElement>("[data-identity-form]")!;
  void loadIdentity(form, () => gitOperation(cwd, "identity", {}), (state) => identityForm(form, state,
    (values) => gitOperation(cwd, "saveIdentity", values), true));
};

export const showIdentityRequired = (ctx: Ctx, cwd: string, repository: string, missing: IdentityKey[]) => {
  const opener = document.activeElement as HTMLElement | null;
  const project = ctx.projects.includes(cwd) ? cwd : undefined;
  const { element, close } = modal(ctx, `<div class="dialog small" role="dialog" aria-modal="true" aria-label="Git の著者設定">
    <div class="mtitle">Git の名前とメールアドレスを設定してください</div>
    <div>${esc(repository)}</div><div>不足している項目は ${missing.map((key) => labels[key]).join("、")}</div>
    <a href="#" data-local>このリポジトリだけに設定</a>
    <div class="mbuttons"><button type="button" class="btn" data-cancel>キャンセル</button>
    <button type="button" class="btn pri" data-global>グローバル設定を開く</button></div>
  </div>`, "[data-cancel]", () => close(), opener);
  element.onclick = (e) => {
    const target = e.target as Element;
    if (target === element || target.closest("[data-cancel]")) close();
    if (target.closest("[data-global]")) {
      close();
      void openSettingsDialog(ctx, "git", nameField, opener);
    }
    if (target.closest("[data-local]")) {
      e.preventDefault();
      close();
      openRepositorySettings(ctx, cwd, project, opener ?? undefined);
    }
  };
};

export const withPullInProgress = async <T>(ctx: Ctx, pull: () => Promise<T>) => {
  const { close } = modal(ctx, `<div class="dialog small" role="dialog" aria-modal="true" aria-label="pull を実行中">
    <div class="mtitle" role="status" tabindex="-1" data-pull-progress>pull を実行中…</div>
  </div>`, "[data-pull-progress]", () => {});
  try {
    return await pull();
  } finally {
    close();
  }
};

export const askGitCredentials = (ctx: Ctx): Promise<GitLogin | null> => new Promise((resolve) => {
  const { element, close } = modal(ctx, `<div class="dialog small" role="dialog" aria-modal="true" aria-label="Git の HTTPS 認証">
    <div class="mtitle">Git の HTTPS 認証</div>
    <form autocomplete="off" data-credentials>
      <label>ユーザー名 <input class="field" name="username" required></label>
      <label>パスワードまたはトークン <input class="field" name="password" type="password" required></label>
      <div class="mbuttons"><button type="button" class="btn" data-cancel>キャンセル</button>
      <button type="submit" class="btn pri">認証する</button></div>
    </form></div>`, "[name=username]", () => done(null));
  const done = (value: GitLogin | null) => { close(); resolve(value); };
  element.onclick = (e) => { if (e.target === element || (e.target as Element).closest("[data-cancel]")) done(null); };
  const form = element.querySelector<HTMLFormElement>("form")!;
  const username = form.querySelector<HTMLInputElement>("[name=username]")!;
  const password = form.querySelector<HTMLInputElement>("[name=password]")!;
  form.onsubmit = (e) => {
    e.preventDefault();
    if (!username.value.trim() || !password.value) return;
    const credentials = { username: username.value.trim(), password: password.value };
    form.reset();
    done(credentials);
  };
});
