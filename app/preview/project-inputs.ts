import { ext } from "../path.ts";
import type { PageSaveKind } from "./page-saves.ts";

export type InputContent = string | null;
export type InputChange = { path: string; before: InputContent; after: InputContent };

export const previewInput = (project: string, path: string): boolean =>
  path === `${project}/manifest.toml` || path === `${project}/style.toml` ||
  (path.startsWith(project + "/") && !path.startsWith(project + "/build/") && ext(path) === "emet");

const formatting = new Map<string, number>();
export const previewInputFormatting = (path: string) => formatting.has(path);

export const withPreviewInputFormatting = async <T>(path: string, run: () => Promise<T>): Promise<T> => {
  if (ext(path) !== "emet") return run();
  formatting.set(path, (formatting.get(path) ?? 0) + 1);
  try {
    return await run();
  } finally {
    const left = formatting.get(path)! - 1;
    if (left) formatting.set(path, left);
    else formatting.delete(path);
  }
};

/** Compare the disk, even for files with no editor (ADR 0113). */
export const createProjectInputs = () => {
  const known = new Map<string, InputContent>();
  const intermediate = new Map<string, InputContent>();
  return {
    paths: () => [...known.keys()],
    start(files: ReadonlyMap<string, InputContent>) {
      for (const [path, content] of files) if (!known.has(path)) known.set(path, content);
    },
    saved(path: string, before: string, after: string, kind: PageSaveKind) {
      if (kind === "intermediate") {
        intermediate.set(path, after);
        return null;
      }
      intermediate.delete(path);
      const alreadySeen = known.get(path) === after;
      known.set(path, after);
      if (before === after) return null;
      if (!alreadySeen) return "changed";
      return kind === "explicit" ? "promote" : null;
    },
    observe(files: ReadonlyMap<string, InputContent>, paused: (path: string) => boolean = () => false) {
      const changes: InputChange[] = [];
      for (const [path, after] of files) {
        if (paused(path) || intermediate.get(path) === after) continue;
        intermediate.delete(path);
        const before = known.get(path) ?? null;
        if (after === null) known.delete(path);
        else known.set(path, after);
        if (before !== after) changes.push({ path, before, after });
      }
      return changes;
    },
  };
};

export const createProjectInputWatch = (
  list: (project: string) => Promise<string[]>,
  read: (path: string) => Promise<InputContent | undefined>,
) => {
  const projects = new Map<string, {
    inputs: ReturnType<typeof createProjectInputs>;
    revision: number;
    scan: Promise<void>;
    ready: Promise<void> | null;
  }>();
  const stateFor = (project: string) => {
    let state = projects.get(project);
    if (!state) {
      state = { inputs: createProjectInputs(), revision: 0, scan: Promise.resolve(), ready: null };
      projects.set(project, state);
    }
    return state;
  };
  const contents = async (paths: Iterable<string>) => {
    const files = new Map<string, InputContent>();
    await Promise.all(Array.from(paths, async (path) => {
      const text = await read(path);
      if (text !== undefined) files.set(path, text);
    }));
    return files;
  };
  const start = (project: string) => {
    const state = stateFor(project);
    state.ready ??= list(project).then(contents).then((files) => state.inputs.start(files));
    return state.ready;
  };
  return {
    start,
    saved(project: string, path: string, before: string, after: string, kind: PageSaveKind) {
      const state = stateFor(project);
      state.revision++;
      return state.inputs.saved(path, before, after, kind);
    },
    changed(paths: string[], rescan: string[], apply: (project: string, changes: InputChange[]) => void) {
      const under = (path: string, directory: string) => path === directory || path.startsWith(directory + "/");
      const scans: Promise<void>[] = [];
      for (const [project, state] of projects) {
        const ready = state.ready;
        if (!ready) continue;
        const direct = paths.filter((path) => previewInput(project, path));
        const directories = rescan.filter((dir) => under(project, dir) || under(dir, project));
        if (!direct.length && !directories.length) continue;
        state.scan = state.scan.then(async () => {
          await ready;
          const manifest = project + "/manifest.toml";
          while (true) {
            const revision = state.revision;
            const candidates = new Set(direct);
            if (directories.length) {
              const listed = await list(project);
              for (const path of [...listed, ...state.inputs.paths()]) {
                if (directories.some((dir) => under(path, dir))) candidates.add(path);
              }
            }
            candidates.add(manifest);
            const files = await contents(candidates);
            if (revision !== state.revision) continue;
            if (files.get(manifest) == null) return;
            const changes = state.inputs.observe(files, previewInputFormatting);
            if (changes.length) apply(project, changes);
            return;
          }
        }).catch(() => {});
        scans.push(state.scan);
      }
      return Promise.all(scans);
    },
  };
};
