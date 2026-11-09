// The pages are built again once the input has stopped for 5 s (docs/adr/0056):
// a build asked for after a save waits, per project, until 5 s after the last edit.

export const WAIT_MS = 5000;

/** The time left before building, from the last edit (none: nothing to wait for). */
export const remaining = (lastEdit: number | undefined, now: number) => (lastEdit === undefined ? 0 : Math.max(0, lastEdit + WAIT_MS - now));

export type Clock = { now: () => number; set: (fn: () => void, ms: number) => number; clear: (id: number) => void };

export const createWaiter = (clock: Clock) => {
  const lastEdit = new Map<string, number>();
  const pending = new Map<string, { id: number; run: () => void }>();
  const arm = (project: string) => {
    const p = pending.get(project);
    if (!p) return;
    clock.clear(p.id);
    p.id = clock.set(() => {
      pending.delete(project);
      p.run();
    }, remaining(lastEdit.get(project), clock.now()));
  };
  return {
    /** A sheet of the project changed: a waiting build counts from now. */
    edited: (project: string) => {
      lastEdit.set(project, clock.now());
      arm(project);
    },
    /** A build after a save: the latest one asked for runs, once. */
    request: (project: string, run: () => void) => {
      const p = pending.get(project);
      if (p) p.run = run;
      else pending.set(project, { id: 0, run });
      arm(project);
    },
    waiting: (project: string) => pending.has(project),
    /** A build run now (the button) drops the waiting one. */
    cancel: (project: string) => {
      const p = pending.get(project);
      if (p) clock.clear(p.id);
      pending.delete(project);
    },
  };
};
