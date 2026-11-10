// Three-way merge by lines, the diff3 procedure (docs/adr/0063): the lines both sides
// keep from the base split the text into stable parts and the parts between; a part
// changed on one side takes that side, the same change on both sides is taken once,
// and different changes on both sides are a conflict for the writer to settle.

export type Chunk = { t: "ok"; lines: string[] } | { t: "conflict"; base: string[]; ours: string[]; theirs: string[] };
/** How a conflict is settled: the disk's lines, the editor's, or both (the editor's first). */
export type Choice = "ours" | "theirs" | "both";

/** Lines as numbers, equal lines the same number. */
const ids = (a: string[], b: string[]) => {
  const table = new Map<string, number>();
  const id = (l: string) => {
    let n = table.get(l);
    if (n === undefined) table.set(l, (n = table.size));
    return n;
  };
  return [a.map(id), b.map(id)];
};

/** Past this many edits, the middle is taken as all changed (Myers' trace would grow too large). */
const MAX_EDITS = 4000;

/**
 * For each line of `a`, the index of the line of `b` it is matched with in a longest common subsequence, or -1
 * (Myers' O((N+M)D) algorithm, after the common head and tail are taken off).
 */
export const matchLines = (a: string[], b: string[]): Int32Array => {
  const out = new Int32Array(a.length).fill(-1);
  const [x, y] = ids(a, b);
  let head = 0;
  while (head < x.length && head < y.length && x[head] === y[head]) {
    out[head] = head;
    head++;
  }
  let tail = 0;
  while (tail < x.length - head && tail < y.length - head && x[x.length - 1 - tail] === y[y.length - 1 - tail]) {
    out[x.length - 1 - tail] = y.length - 1 - tail;
    tail++;
  }
  const A = x.slice(head, x.length - tail);
  const B = y.slice(head, y.length - tail);
  const n = A.length;
  const m = B.length;
  if (!n || !m) return out;
  const max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= Math.min(max, MAX_EDITS) && found < 0; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let i = k === -d || (k !== d && v[k - 1 + off] < v[k + 1 + off]) ? v[k + 1 + off] : v[k - 1 + off] + 1;
      let j = i - k;
      while (i < n && j < m && A[i] === B[j]) {
        i++;
        j++;
      }
      v[k + off] = i;
      if (i >= n && j >= m) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) return out;
  // back through the trace: the diagonal runs are the matches
  let i = n;
  let j = m;
  for (let d = found; d > 0; d--) {
    const tv = trace[d];
    const k = i - j;
    const pk = k === -d || (k !== d && tv[k - 1 + off] < tv[k + 1 + off]) ? k + 1 : k - 1;
    const pi = tv[pk + off];
    const pj = pi - pk;
    while (i > pi && j > pj) {
      out[head + i - 1] = head + j - 1;
      i--;
      j--;
    }
    i = pi;
    j = pj;
  }
  while (i > 0 && j > 0) {
    out[head + i - 1] = head + j - 1;
    i--;
    j--;
  }
  return out;
};

const same = (a: string[], b: string[]) => a.length === b.length && a.every((l, k) => l === b[k]);

export const merge3 = (base: string, ours: string, theirs: string): { chunks: Chunk[]; conflicts: number } => {
  const B = base.split("\n");
  const O = ours.split("\n");
  const T = theirs.split("\n");
  const mo = matchLines(B, O);
  const mt = matchLines(B, T);
  const chunks: Chunk[] = [];
  let conflicts = 0;
  const ok = (ls: string[]) => {
    if (!ls.length) return;
    const last = chunks[chunks.length - 1];
    if (last?.t === "ok") last.lines.push(...ls);
    else chunks.push({ t: "ok", lines: [...ls] });
  };
  /** The part between two stable lines. */
  const between = (b: string[], o: string[], t: string[]) => {
    if (same(o, b)) ok(t);
    else if (same(t, b)) ok(o);
    else if (same(o, t)) ok(o);
    else {
      chunks.push({ t: "conflict", base: b, ours: o, theirs: t });
      conflicts++;
    }
  };
  let i = 0;
  let a = 0;
  let c = 0;
  for (let k = 0; k < B.length; k++) {
    // a stable line: kept by both sides, in order
    if (mo[k] < a || mt[k] < c) continue;
    between(B.slice(i, k), O.slice(a, mo[k]), T.slice(c, mt[k]));
    ok([B[k]]);
    i = k + 1;
    a = mo[k] + 1;
    c = mt[k] + 1;
  }
  between(B.slice(i), O.slice(a), T.slice(c));
  return { chunks, conflicts };
};

/** The text with each conflict settled by its choice (ours when none is given). */
export const resolve = (chunks: Chunk[], choices: Choice[]): string => {
  let n = 0;
  return chunks
    .flatMap((ch) => {
      if (ch.t === "ok") return ch.lines;
      const c = choices[n++] ?? "ours";
      return c === "ours" ? ch.ours : c === "theirs" ? ch.theirs : [...ch.ours, ...ch.theirs];
    })
    .join("\n");
};
