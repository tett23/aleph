// The runs that write a project's build/ (golem build for the previews and for
// the writer, docs/adr/0058) go one after another, so two never write it at once.
const chains = new Map<string, Promise<unknown>>();

export const withBuildDir = <T>(project: string, fn: () => Promise<T>): Promise<T> => {
  const next = (chains.get(project) ?? Promise.resolve()).then(fn);
  chains.set(
    project,
    next.catch(() => {}),
  );
  return next;
};
