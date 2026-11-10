// The notifications (docs/adr/0064), apart from the DOM: those shown, their timers, the
// history and the count since it was last seen. The clock is given, so tests move it.

export type Level = "info" | "warning" | "error";
/** A button: `keep` leaves the notification open after it runs. */
export type Action = { label: string; run: () => void; primary?: boolean; keep?: boolean };
export type NotifyOpts = { message: string; level?: Level; sticky?: boolean; actions?: Action[]; key?: string };

export type Note = {
  id: number;
  message: string;
  level: Level;
  sticky: boolean;
  actions: Action[];
  key: string | null;
  /** When it was given, by the clock. */
  at: number;
  /** How many notifications with its key it stands for. */
  repeats: number;
  /** Still on the screen. */
  live: boolean;
};

export type Clock = { now: () => number; set: (fn: () => void, ms: number) => number; clear: (id: number) => void };
export type Handle = { id: number; dismiss: () => void; update: (message: string) => void };

export const TIMEOUT = 5000;
export const MAX_SHOWN = 4;
export const HISTORY_MAX = 500;

export const createNotifications = (clock: Clock) => {
  let seq = 0;
  /** Every notification, newest first; the live ones are on the screen. */
  let notes: Note[] = [];
  const timers = new Map<number, { handle: number; started: number; left: number }>();
  const hovered = new Set<number>();
  const listeners: (() => void)[] = [];
  let unseen = 0;
  let unseenError = false;
  let expanded = false;

  const changed = () => listeners.forEach((f) => f());

  const startTimer = (n: Note, ms: number) => {
    const handle = clock.set(() => close(n.id), ms);
    timers.set(n.id, { handle, started: clock.now(), left: ms });
  };
  const stopTimer = (id: number) => {
    const t = timers.get(id);
    if (t) clock.clear(t.handle);
    timers.delete(id);
  };

  const close = (id: number) => {
    const n = notes.find((x) => x.id === id);
    if (!n || !n.live) return;
    n.live = false;
    stopTimer(id);
    hovered.delete(id);
    if (!notes.some((x) => x.live)) expanded = false;
    changed();
  };

  /** The live ones, oldest first. */
  const live = () => notes.filter((x) => x.live).reverse();

  const add = (o: NotifyOpts, show: boolean): Note => {
    const key = o.key ?? null;
    let repeats = 1;
    if (key) {
      const before = notes.find((x) => x.key === key);
      if (before) {
        repeats = before.repeats + 1;
        stopTimer(before.id);
        hovered.delete(before.id);
        notes = notes.filter((x) => x !== before);
      }
    }
    const n: Note = { id: ++seq, message: o.message, level: o.level ?? "info", sticky: !!o.sticky, actions: o.actions ?? [], key, at: clock.now(), repeats, live: show };
    notes.unshift(n);
    if (notes.length > HISTORY_MAX) {
      // the oldest that are not on the screen go
      const keep = new Set(notes.filter((x) => x.live).map((x) => x.id));
      while (notes.length > HISTORY_MAX) {
        const k = notes.map((x) => keep.has(x.id)).lastIndexOf(false);
        if (k < 0) break;
        notes.splice(k, 1);
      }
    }
    unseen++;
    if (n.level === "error") unseenError = true;
    if (show) {
      if (!n.sticky) startTimer(n, TIMEOUT);
      // too many on the screen: the oldest timed ones close; sticky ones never close for the count
      for (const old of live()) {
        if (live().length <= MAX_SHOWN) break;
        if (!old.sticky && old !== n) {
          old.live = false;
          stopTimer(old.id);
          hovered.delete(old.id);
        }
      }
    }
    changed();
    return n;
  };

  const handle = (n: Note): Handle => ({
    id: n.id,
    dismiss: () => close(n.id),
    update: (message: string) => {
      n.message = message;
      changed();
    },
  });

  return {
    notify: (o: NotifyOpts): Handle => handle(add(o, true)),
    /** Into the history only (a notification another window showed). */
    record: (o: NotifyOpts): void => void add({ ...o, sticky: true, actions: [] }, false),
    dismiss: close,
    dismissKey: (key: string) => {
      const n = notes.find((x) => x.key === key && x.live);
      if (n) close(n.id);
    },
    /** The pointer on a timed notification stops its clock; off it, the clock starts again from the full time. */
    hover: (id: number, on: boolean) => {
      const n = notes.find((x) => x.id === id);
      if (!n || !n.live || n.sticky) return;
      if (on) {
        hovered.add(id);
        stopTimer(id);
      } else if (hovered.delete(id)) startTimer(n, TIMEOUT);
    },
    press: (id: number, index: number) => {
      const n = notes.find((x) => x.id === id);
      const a = n?.live ? n.actions[index] : undefined;
      if (!n || !a) return;
      if (!a.keep) close(id);
      a.run();
    },
    /** The ones to draw, oldest first: at most MAX_SHOWN unless expanded, and how many more there are. */
    shown: (): { notes: Note[]; more: number } => {
      const l = live();
      if (expanded || l.length <= MAX_SHOWN) return { notes: l, more: 0 };
      return { notes: l.slice(l.length - MAX_SHOWN), more: l.length - MAX_SHOWN };
    },
    expand: (on: boolean) => {
      expanded = on;
      changed();
    },
    history: (): Note[] => notes,
    clearHistory: () => {
      notes = notes.filter((x) => x.live);
      changed();
    },
    unseen: () => ({ count: unseen, error: unseenError }),
    seen: () => {
      if (!unseen && !unseenError) return;
      unseen = 0;
      unseenError = false;
      changed();
    },
    subscribe: (f: () => void) => void listeners.push(f),
  };
};

export type Notifications = ReturnType<typeof createNotifications>;
