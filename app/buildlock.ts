// Runs that must not overlap go one after another by key (docs/adr/0062): the writers
// of a project's build/ (golem build for the previews and for the writer, and golem
// fmt, docs/adr/0058), and git's writes in a workspace. Since the programs run off
// the main thread, nothing else keeps them apart.
const chains = new Map<string, Promise<unknown>>();

/** Runs `fn` after the runs asked for earlier under `key` (failed or not); other keys do not wait. */
export const withLock = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
  const next = (chains.get(key) ?? Promise.resolve()).then(fn);
  chains.set(
    key,
    next.catch(() => {}),
  );
  return next;
};

export const withBuildDir = <T>(project: string, fn: () => Promise<T>): Promise<T> => withLock(`build\n${project}`, fn);
