// What is decided before the assistant's edit is applied (docs/adr/0088): which dialog to show,
// whether the workspace has changes not committed, and the message of the commit before applying.
// Pure: no DOM and no Tauri here, so that node --test can run it.
import { ymd } from "../git.ts";

/** Ask to commit first, apply as it is, or say the edit cannot be undone with Git. */
export type ApplyDecision = "commit" | "apply" | "irreversible";

/**
 * I5: with git, a repository and the sheet in the workspace, ask to commit when there are changes and apply
 * when there are none; otherwise (no git, not a repository, `git status` failed (`changed` null), the sheet
 * in the shared library) say that the edit cannot be undone with Git.
 */
export const applyDecision = (o: { git: boolean; repo: boolean; inWorkspace: boolean; changed: boolean | null }): ApplyDecision =>
  !o.git || !o.repo || !o.inWorkspace || o.changed === null ? "irreversible" : o.changed ? "commit" : "apply";

/** I5: changes not committed: a sheet of the workspace not saved, or an entry of `git status -- .`. */
export const hasChanges = (unsaved: number, entries: number): boolean => unsaved > 0 || entries > 0;

/** I12: `Before the assistant's edit YYYY-MM-DD HH:MM`, in the writer's local time. */
export const commitMessage = (d: Date): string =>
  `Before the assistant's edit ${ymd(d)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
