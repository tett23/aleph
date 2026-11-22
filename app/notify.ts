// The notifications (docs/adr/0064), apart from the DOM: those shown, their timers, the
// history and the count since it was last seen. The clock is given, so tests move it.

export type Level = "info" | "warning" | "error";
/** A button: `keep` leaves the notification open after it runs. */
export type Action = { label: string; run: () => void; primary?: boolean; keep?: boolean };
/** How far some work has gone (docs/adr/0078): `value` from 0 to 1, and a count to show beside the bar. */
export type ProgressOpts = { value: number; text: string };
export type NotifyOpts = { message: string; level?: Level; sticky?: boolean; actions?: Action[]; key?: string; progress?: ProgressOpts };

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
  /** A bar (docs/adr/0078): updated in place by its key, never kept in the history. */
  progress: ProgressOpts | null;
};

export type Clock = { now: () => number; set: (fn: () => void, ms: number) => number; clear: (id: number) => void };
export type Handle = { id: number; dismiss: () => void; update: (message: string) => void };

type NotificationIdentity = { origin: string };
type Added = NotificationIdentity & {
  type: "added";
  id: number;
  message: string;
  level: Level;
  sticky: boolean;
  key?: string;
  at?: number;
};
export type NotificationEvent = Added | (NotificationIdentity & { type: "acknowledged"; ids: readonly number[] });
type Forwarding = NotificationIdentity & { send: (event: NotificationEvent) => void };

export const TIMEOUT = 5000;
export const MAX_SHOWN = 4;
export const HISTORY_MAX = 500;

export const createNotifications = (clock: Clock, forwarding?: Forwarding) => {
  let seq = 0;
  /** Every notification, newest first; the live ones are on the screen. */
  let notes: Note[] = [];
  const timers = new Map<number, { handle: number; started: number; left: number }>();
  const hovered = new Set<number>();
  const listeners: (() => void)[] = [];
  // Occurrences outlive their history rows until they are seen.
  const unseen = new Map<number, Level>();
  let unseenErrors = 0;
  // Replacing a local row transfers its occurrences, including those the receiving window may not have seen.
  const occurrences = new WeakMap<Note, number[]>();
  const remoteRows = new WeakMap<Note, Pick<Added, "origin" | "id">>();
  // A number maps a delivered source ID to its local occurrence. Null is an acknowledgment received first.
  const received = new Map<string, Map<number, number | null>>();
  let expanded = false;

  const changed = () => listeners.forEach((f) => f());

  const count = (id: number, level: Level) => {
    unseen.set(id, level);
    if (level === "error") unseenErrors++;
  };

  const acknowledge = (id: number) => {
    if (unseen.get(id) === "error") unseenErrors--;
    return unseen.delete(id);
  };

  const startTimer = (n: Note, ms: number) => {
    const handle = clock.set(() => close(n.id), ms);
    timers.set(n.id, { handle, started: clock.now(), left: ms });
  };
  const stopTimer = (id: number) => {
    const t = timers.get(id);
    if (t) clock.clear(t.handle);
    timers.delete(id);
  };

  const close = (id: number, byUser = false) => {
    const n = notes.find((x) => x.id === id);
    if (!n || !n.live) return;
    n.live = false;
    n.actions = [];
    if (byUser && n.sticky && !n.progress) {
      const ids = occurrences.get(n) ?? [id];
      for (const occurrence of ids) acknowledge(occurrence);
      occurrences.delete(n);
      forwarding?.send({ type: "acknowledged", origin: forwarding.origin, ids });
    }
    stopTimer(id);
    hovered.delete(id);
    if (!notes.some((x) => x.live)) expanded = false;
    changed();
  };

  /** The live ones, oldest first. */
  const live = () => notes.filter((x) => x.live).reverse();

  const clamp = (p: ProgressOpts): ProgressOpts => ({ value: Math.min(1, Math.max(0, p.value)), text: p.text });

  const findGroup = (key: string, origin?: string) =>
    notes.find((n) => n.key === key && remoteRows.get(n)?.origin === origin);

  const add = (o: NotifyOpts, show: boolean, remote?: Added, alreadyAcknowledged = false): Note => {
    const key = o.key ?? null;
    let repeats = 1;
    let grouped: number[] | undefined;
    if (key) {
      const before = findGroup(key, remote?.origin);
      // a new value of a bar: the same toast, shown again only if it still is (docs/adr/0078)
      if (before?.progress && o.progress) {
        before.message = o.message;
        before.progress = clamp(o.progress);
        changed();
        return before;
      }
      if (before) {
        repeats = before.progress ? 1 : before.repeats + 1;
        if (!o.progress) grouped = occurrences.get(before);
        occurrences.delete(before);
        stopTimer(before.id);
        hovered.delete(before.id);
        notes = notes.filter((x) => x !== before);
      }
    }
    const n: Note = {
      id: ++seq, message: o.message, level: o.level ?? "info", sticky: !!o.sticky,
      actions: o.actions ?? [], key, at: remote?.at ?? clock.now(), repeats, live: show,
      progress: o.progress ? clamp(o.progress) : null,
    };
    notes.unshift(n);
    if (remote) remoteRows.set(n, { origin: remote.origin, id: remote.id });
    if (notes.length > HISTORY_MAX) {
      // the oldest that are not on the screen go
      const keep = new Set(notes.filter((x) => x.live).map((x) => x.id));
      while (notes.length > HISTORY_MAX) {
        const k = notes.map((x) => keep.has(x.id)).lastIndexOf(false);
        if (k < 0) break;
        notes.splice(k, 1);
      }
    }
    if (!n.progress) {
      if (!alreadyAcknowledged) count(n.id, n.level);
      if (show && key) {
        const ids = grouped ?? [];
        ids.push(n.id);
        occurrences.set(n, ids);
      }
      if (show) forwarding?.send({
        type: "added", origin: forwarding.origin, id: n.id, message: n.message,
        level: n.level, sticky: n.sticky, key: o.key, at: n.at,
      });
    }
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
    if (!remote) changed();
    return n;
  };

  const receive = (event: NotificationEvent) => {
    let ids = received.get(event.origin);
    if (!ids) {
      ids = new Map();
      received.set(event.origin, ids);
    }
    if (event.type === "added") {
      const before = ids.get(event.id);
      if (typeof before === "number") return;
      const group = event.key ? findGroup(event.key, event.origin) : undefined;
      if (group && remoteRows.get(group)!.id > event.id) {
        // Count the delayed occurrence without replacing the latest history row.
        const id = ++seq;
        group.repeats++;
        if (before !== null) count(id, event.level);
        ids.set(event.id, id);
      } else {
        ids.set(event.id, add(event, false, event, before === null).id);
      }
      changed();
      return;
    }
    let updated = false;
    for (const id of event.ids) {
      const local = ids.get(id);
      if (local === undefined) ids.set(id, null);
      if (typeof local === "number" && acknowledge(local)) updated = true;
    }
    if (updated) changed();
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
    receive,
    dismiss: (id: number) => close(id),
    dismissByUser: (id: number) => close(id, true),
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
      if (!a.keep) close(id, true);
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
    /** Every one given, newest first, but the bars (docs/adr/0078). */
    history: (): Note[] => notes.filter((x) => !x.progress),
    clearHistory: () => {
      notes = notes.filter((x) => x.live);
      changed();
    },
    unseen: () => ({ count: unseen.size, error: unseenErrors > 0 }),
    seen: () => {
      if (!unseen.size) return;
      unseen.clear();
      unseenErrors = 0;
      if (!forwarding) for (const n of notes) occurrences.delete(n);
      changed();
    },
    subscribe: (f: () => void) => void listeners.push(f),
  };
};

export type Notifications = ReturnType<typeof createNotifications>;
