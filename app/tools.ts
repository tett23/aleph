// golem and shem, found by the setting, the bundled copy, ~/.local/bin, Homebrew, then PATH (docs/adr/0008).
// Rust reads the setting itself (docs/adr/0042); the paths change only through it (docs/adr/0050).
import { api, type Out, type Tool } from "./api.ts";
import { withLock } from "./buildlock.ts";
import { adopt } from "./config.ts";
import { gitWrites } from "./git.ts";
import type { Ctx } from "./ctx.ts";
import { esc } from "./esc.ts";
import { item } from "./ui/settings.ts";

export const golem = (_ctx: Ctx, cwd: string, args: string[]): Promise<Out> => api.tool("golem", cwd, args);
export const shem = (_ctx: Ctx, cwd: string, args: string[]): Promise<Out> => api.tool("shem", cwd, args);
// whether git can be used: checked once at start, and again when its path changes or the writer asks
// (docs/adr/0060); while it cannot, git is not run at all
export type GitState = { ok: true; path: string; version: string } | { ok: false; reason: string };
let gitState: Promise<GitState> | null = null;
export const checkGit = (): Promise<GitState> =>
  (gitState = api.gitInfo().then(
    (i): GitState => ({ ok: true, ...i }),
    (e): GitState => ({ ok: false, reason: String(e) }),
  ));
export const gitNow = (): Promise<GitState> => gitState ?? checkGit();
export const gitOk = async () => (await gitNow()).ok;

export const git = async (_ctx: Ctx, cwd: string, args: string[]): Promise<Out> => {
  const s = await gitNow();
  if (!s.ok) throw new Error(s.reason);
  // writes in one workspace one at a time; reads run alongside (docs/adr/0062)
  return gitWrites(args) ? withLock(`git\n${cwd}`, () => api.git(cwd, args)) : api.git(cwd, args);
};

const info = async (name: Tool) => {
  try {
    const i = await api.toolInfo(name);
    const differs = i.bundled && !i.version.includes(i.bundled.replace(/^v/, ""));
    return `${esc(i.version)}（${esc(i.path)}）${differs ? `<br>同梱の版は ${esc(i.bundled)}` : ""}`;
  } catch (e) {
    return `<span class="ng">${esc(String(e))}</span>`;
  }
};

const gitLine = async () => {
  const s = await gitNow();
  return s.ok ? `${esc(s.version)}（${esc(s.path)}）` : `<span class="ng">${esc(s.reason)}</span>`;
};

const PROGRAM = { golemPath: "golem", shemPath: "shem", gitPath: "git" } as const;

/** After git's path changed or the writer asked: check again, then the panel, the tree's marks and the change marks follow. */
export const gitChanged = async (ctx: Ctx) => {
  await checkGit();
  ctx.gitChanged.forEach((f) => f());
};

export const mountTools = (ctx: Ctx) => {
  ctx.settings.push({
    id: "tools",
    label: "Golem と shem",
    group: "Golem",
    render: async (c) =>
      item("Golem のバイナリ", `${await info("golem")}<br>空なら、同梱のもの、~/.local/bin、Homebrew、PATH の順に探す`, `<input class="field" data-path="golemPath" value="${esc(c.config.golemPath)}" placeholder="同梱"><span class="btn" data-pick="golemPath">選ぶ</span>`) +
      item("shem のバイナリ", `${await info("shem")}<br>ページのプレビューで PDF を PNG にする`, `<input class="field" data-path="shemPath" value="${esc(c.config.shemPath)}" placeholder="同梱"><span class="btn" data-pick="shemPath">選ぶ</span>`) +
      item("git のバイナリ", `${await gitLine()}<br>空なら、/usr/bin、Homebrew、PATH の順に探す`, `<input class="field" data-path="gitPath" value="${esc(c.config.gitPath)}" placeholder="自動"><span class="btn" data-pick="gitPath">選ぶ</span>`),
    onClick: async (el, c) => {
      const k = el.closest<HTMLElement>("[data-pick]")?.dataset.pick as keyof typeof PROGRAM | undefined;
      if (!k) return false;
      const written = await api.chooseBinary(PROGRAM[k]);
      if (!written) return false;
      adopt(c.config, written);
      await c.saveConfig();
      if (k === "gitPath") await gitChanged(c);
      return true;
    },
    onChange: async (el, c) => {
      const k = el.dataset.path as keyof typeof PROGRAM | undefined;
      if (!k) return false;
      // a typed path is used after a native confirmation; stopped, the field goes back
      const written = await api.setBinary(PROGRAM[k], el.value);
      if (written) adopt(c.config, written);
      await c.saveConfig();
      if (k === "gitPath") await gitChanged(c);
      return true;
    },
  });
};
