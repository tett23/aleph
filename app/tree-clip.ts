// The tree's cut and paste (docs/adr/0109), apart from the DOM and Tauri: a cut is one
// path and the pasteboard's changeCount at the time; it stays only in memory, and the
// files stay where they are until a paste moves them.

/** The one item cut, with the pasteboard's changeCount when it was cut. */
export type Cut = { path: string; count: number } | null;

/** What a paste and a cut need from the app; tests give their own. */
export type ClipDeps = {
  /** The general pasteboard's changeCount and how many file URLs it holds. */
  board: () => Promise<{ count: number; files: number }>;
  exists: (path: string) => Promise<boolean>;
  /** Moves `from` into `dir` as a drag does; true when the move ended on disk. */
  move: (from: string, dir: string) => Promise<boolean>;
  /** Copies the pasteboard's files into `dir`. */
  copy: (dir: string) => Promise<void>;
  notify: (message: string) => void;
};

export const createClip = () => {
  let cut: Cut = null;
  const listeners: (() => void)[] = [];
  const set = (next: Cut) => {
    if (next === cut) return;
    cut = next;
    for (const listen of listeners) listen();
  };
  return {
    current: (): Cut => cut,
    listen: (listen: () => void) => { listeners.push(listen); },
    /** Cuts one item; the disk and the documents do not change (I1, I2). */
    cut: async (path: string, d: Pick<ClipDeps, "board">) => {
      const { count } = await d.board();
      set({ path, count });
    },
    cancel: () => set(null),
    /** The tree's "コピー" was chosen: what was copied goes before the cut (I2). */
    copied: () => set(null),
    /** Another workspace was opened: a cut cannot move across workspaces (I2). */
    switched: () => set(null),
    /** Pastes into `dir`: the cut's move while the pasteboard is as it was, else the pasteboard's files (I3–I5, I7). */
    paste: async (dir: string, d: ClipDeps) => {
      const board = await d.board();
      const held = cut;
      if (held && held.count === board.count) {
        if (!(await d.exists(held.path))) {
          set(null);
          return d.notify(`${held.path} が見つかりません`);
        }
        if (await d.move(held.path, dir)) set(null);
        return;
      }
      if (held) set(null);
      if (board.files > 0) return d.copy(dir);
      d.notify("貼り付けるものがありません");
    },
  };
};

export type Clip = ReturnType<typeof createClip>;
