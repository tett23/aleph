// Long notifications fold to six lines and open in place (docs/adr/0111), apart from the
// DOM: whether a notification's text was measured long and whether it is open, kept by its
// key (by its id when it has none) while it is on the screen.

/** One notification's state; a text not yet measured is not long. */
export type Fold = { long: boolean; open: boolean };

/** The key of a notification's state: its key, so a replacement keeps it, else its id. */
export const foldKey = (n: { id: number; key: string | null }) => (n.key !== null ? `k:${n.key}` : `i:${n.id}`);

export const createFolds = () => {
  const folds = new Map<string, Fold>();
  const of = (k: string): Fold => folds.get(k) ?? { long: false, open: false };
  return {
    of,
    /** Records a measurement; true when it changed whether the text is long. */
    measured: (k: string, long: boolean): boolean => {
      const now = of(k);
      if (now.long === long) return false;
      folds.set(k, { ...now, long });
      return true;
    },
    toggle: (k: string) => {
      const now = of(k);
      folds.set(k, { ...now, open: !now.open });
    },
    /** Drops the states of the notifications no longer on the screen (I4). */
    keep: (live: Set<string>) => {
      for (const k of folds.keys()) if (!live.has(k)) folds.delete(k);
    },
  };
};
