// What the Git features decide without running git (docs/adr/0011, docs/adr/0060).
import { esc } from "./esc.ts";

export type StatusEntry = { code: string; path: string; from?: string };

/** The local date, YYYY-MM-DD. */
export const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export const autosaveMessage = (d: Date) => `Autosave ${ymd(d)}`;

/** Once a day per workspace, when there are changes, the setting is on and git can be used. */
export const shouldAutoCommit = (o: { today: string; last: string | undefined; changed: boolean; enabled: boolean; git: boolean }) =>
  o.git && o.enabled && o.changed && o.last !== o.today;

/** The Git panel when git cannot be used: why, how to install it, and no git init (docs/adr/0060). */
export const gitMissingHtml = (reason: string) =>
  `<div class="sec"><div class="muted">git が使えません。<br><span class="ng">${esc(reason)}</span><br>Xcode のコマンドラインツール（<code>xcode-select --install</code>）か Homebrew で入れてから、確かめなおしてください。</div><div class="row"><span class="btn pri" data-a="recheck">確かめなおす</span><span class="btn" data-a="settings">設定を開く</span></div></div>`;

/** `git status --porcelain=v1 -z`: NUL-separated entries; a rename is followed by its old path. */
export const parseStatus = (z: string): StatusEntry[] => {
  const parts = z.split("\0");
  const out: StatusEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.length < 4) continue;
    const xy = p.slice(0, 2);
    const e: StatusEntry = { code: xy.trim() === "??" ? "??" : xy.trim()[0], path: p.slice(3) };
    if (xy[0] === "R" || xy[0] === "C") e.from = parts[++i];
    out.push(e);
  }
  return out;
};

const WRITES = ["add", "commit", "init", "pull", "push"];

/** Whether git's arguments write the repository (docs/adr/0062): those go one at a time per workspace. */
export const gitWrites = (args: string[]) => WRITES.includes(args[0] ?? "");
