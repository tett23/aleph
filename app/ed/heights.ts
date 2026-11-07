// The size of each line along the block axis (height in horizontal writing,
// width in vertical), measured once drawn and estimated before, kept in a
// Fenwick tree so sums and lookups stay fast for long documents (docs/adr/0019).

export const estimateSize = (chars: number, perLine: number, lineSize: number) => Math.max(1, Math.ceil(chars / Math.max(1, perLine))) * lineSize;

export const createHeights = (initial: number[]) => {
  let sizes = [...initial];
  let tree: number[] = [];
  const build = () => {
    tree = new Array(sizes.length + 1).fill(0);
    sizes.forEach((v, i) => {
      for (let j = i + 1; j < tree.length; j += j & -j) tree[j] += v;
    });
  };
  build();
  const prefix = (n: number) => {
    let s = 0;
    for (let j = n; j > 0; j -= j & -j) s += tree[j];
    return s;
  };
  return {
    count: () => sizes.length,
    size: (i: number) => sizes[i],
    total: () => prefix(sizes.length),
    /** Where line i (0-based) starts along the block axis. */
    offsetOf: (i: number) => prefix(Math.max(0, Math.min(i, sizes.length))),
    /** The line (0-based) at an offset along the block axis. */
    lineAt: (offset: number) => {
      let pos = 0;
      let rem = offset;
      let step = 1;
      while (step * 2 <= sizes.length) step *= 2;
      for (; step > 0; step >>= 1)
        if (pos + step <= sizes.length && tree[pos + step] <= rem) {
          pos += step;
          rem -= tree[pos];
        }
      return Math.min(pos, sizes.length - 1);
    },
    set: (i: number, v: number) => {
      const d = v - sizes[i];
      if (!d) return;
      sizes[i] = v;
      for (let j = i + 1; j < tree.length; j += j & -j) tree[j] += d;
    },
    /** Lines `at`..`at+removed-1` replaced by lines of the given sizes. */
    splice: (at: number, removed: number, added: number[]) => {
      sizes = [...sizes.slice(0, at), ...added, ...sizes.slice(at + removed)];
      build();
    },
  };
};

export type Heights = ReturnType<typeof createHeights>;

/** The lines to draw (0-based, inclusive ranges): those within the view and a margin on each side, and the lines that must be drawn. */
export const renderRange = (h: Heights, scrollStart: number, viewSize: number, margin: number, must: number[]): { from: number; to: number }[] => {
  const from = h.lineAt(Math.max(0, scrollStart - margin));
  const to = h.lineAt(Math.max(0, scrollStart + viewSize + margin - 1));
  const ranges = [{ from, to }, ...must.filter((l) => l >= 0 && l < h.count() && (l < from || l > to)).map((l) => ({ from: l, to: l }))];
  ranges.sort((a, b) => a.from - b.from);
  return ranges.reduce<{ from: number; to: number }[]>((acc, r) => {
    const last = acc[acc.length - 1];
    if (last && r.from <= last.to + 1) last.to = Math.max(last.to, r.to);
    else acc.push({ ...r });
    return acc;
  }, []);
};

type Box = { left: number; top: number; right: number; bottom: number; width: number; height: number };

/** The viewport along the block axis, from the start of the lines: down from the top in horizontal writing, left from the right edge in vertical. */
export const blockViewport = (vertical: boolean, scroller: Box, origin: Box) =>
  vertical ? { start: origin.right - scroller.right, size: scroller.width } : { start: scroller.top - origin.top, size: scroller.height };

const EDGE = 24;

/** Where the viewport should start to show a line at `at` of `size`: centred, or moved just enough to bring it in. */
export const scrollTarget = (at: number, size: number, vp: { start: number; size: number }, center: boolean) =>
  center ? at - vp.size * 0.4 : at < vp.start ? at - EDGE : at + size > vp.start + vp.size ? at + size - vp.size + EDGE : vp.start;

/** A point moved just inside a box (a press right of the lines, or beyond their ends, finds the nearest line). */
export const clampPoint = (box: Box, x: number, y: number) => ({
  x: Math.min(Math.max(x, box.left + 1), box.right - 1),
  y: Math.min(Math.max(y, box.top + 1), box.bottom - 1),
});
