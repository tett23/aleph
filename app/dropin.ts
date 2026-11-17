// Drops from Finder and other applications onto the tree (docs/adr/0078), apart from the
// DOM and Tauri: where a drop goes, the bar of the copy, the toast that shows it after a
// while, and the notification at the end. The clock and notify are given, so tests move them.
import type { Clock, Handle, Level, NotifyOpts } from "./notify.ts";
import { dirname } from "./path.ts";

/** Where a drop fell in the tree: a folder's (or project's) row, a file's row, or the tree without a row. */
export type Hit = { kind: "dir"; path: string } | { kind: "file"; path: string } | { kind: "empty" } | null;

/** What became of one dropped item: the path it went to, or why it did not. */
export type Outcome = { name: string; path: string | null; error: string | null };

/** How far a copy has gone, as Rust reports it. */
export type Progress = { bytes: number; bytesTotal: number; files: number; filesTotal: number };

/** How long a copy goes before its progress toast shows. */
export const PROGRESS_DELAY = 500;

/** The folder a drop goes into; null where the tree takes nothing. */
export const dropTarget = (hit: Hit, workspace: string | null): string | null => {
  if (!hit) return null;
  if (hit.kind === "dir") return hit.path;
  if (hit.kind === "file") return dirname(hit.path);
  return workspace;
};

/** The length of the bar: by bytes, or by files when there are no bytes at all. */
export const progressValue = (p: Progress): number => {
  const v = p.bytesTotal > 0 ? p.bytes / p.bytesTotal : p.filesTotal > 0 ? p.files / p.filesTotal : 0;
  return Math.min(1, Math.max(0, v));
};

const progressOpts = (key: string, target: string, p: Progress): NotifyOpts => ({
  key,
  sticky: true,
  message: `${target} にコピーしています`,
  progress: { value: progressValue(p), text: `${p.files} / ${p.filesTotal}` },
});

/** The notification at the end: what was copied, and what was not with why. */
export const dropResult = (target: string, outcomes: Outcome[]): { message: string; level: Level; sticky: boolean } => {
  const copied = outcomes.filter((o) => !o.error);
  const failed = outcomes.filter((o) => o.error);
  const lines = [
    copied.length ? `${target} にコピーしました：${copied.map((o) => o.name).join("、")}` : "",
    failed.length ? `${target} にコピーできなかったもの：\n${failed.map((o) => `・${o.name}（${o.error}）`).join("\n")}` : "",
  ].filter(Boolean);
  const level: Level = !failed.length ? "info" : copied.length ? "warning" : "error";
  return { message: lines.join("\n") || `${target} にコピーするものはありませんでした`, level, sticky: failed.length > 0 };
};

/**
 * Runs a copy, showing its progress toast only if it has not ended PROGRESS_DELAY after it
 * began; the toast stays until the end, when the result takes its place (docs/adr/0078).
 * A copy that fails as a whole ends with an error notification and rejects.
 */
export const copyWithProgress = async (o: {
  clock: Clock;
  notify: (n: NotifyOpts) => Handle;
  key: string;
  target: string;
  run: (onProgress: (p: Progress) => void) => Promise<Outcome[]>;
}): Promise<Outcome[]> => {
  let last: Progress = { bytes: 0, bytesTotal: 0, files: 0, filesTotal: 0 };
  let shown = false;
  let ended = false;
  const timer = o.clock.set(() => {
    if (ended) return;
    shown = true;
    o.notify(progressOpts(o.key, o.target, last));
  }, PROGRESS_DELAY);
  const onProgress = (p: Progress) => {
    last = p;
    if (shown && !ended) o.notify(progressOpts(o.key, o.target, p));
  };
  const end = () => {
    ended = true;
    o.clock.clear(timer);
  };
  try {
    const outcomes = await o.run(onProgress);
    end();
    o.notify({ key: o.key, ...dropResult(o.target, outcomes) });
    return outcomes;
  } catch (e) {
    end();
    o.notify({ key: o.key, level: "error", sticky: true, message: `${o.target} にコピーできませんでした：${e instanceof Error ? e.message : String(e)}` });
    throw e;
  }
};
