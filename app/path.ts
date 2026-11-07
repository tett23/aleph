// Paths as strings ("/" separated, as on macOS).

export const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);
export const dirname = (p: string) => p.slice(0, p.lastIndexOf("/"));
export const ext = (p: string) => {
  const b = basename(p);
  const i = b.lastIndexOf(".");
  return i <= 0 ? "" : b.slice(i + 1).toLowerCase();
};
export const stem = (p: string) => {
  const b = basename(p);
  const i = b.lastIndexOf(".");
  return i <= 0 ? b : b.slice(0, i);
};
/** `p` relative to `root`, or `p` itself outside it. */
export const rel = (root: string, p: string) => (p.startsWith(root + "/") ? p.slice(root.length + 1) : p);
/** `p` against the directory `dir`; an absolute `p` is itself. */
export const resolve = (dir: string, p: string) =>
  "/" +
  (p.startsWith("/") ? p : `${dir}/${p}`)
    .split("/")
    .reduce<string[]>((acc, part) => (part === ".." ? acc.slice(0, -1) : part && part !== "." ? [...acc, part] : acc), [])
    .join("/");

/**
 * A path from a data file (a bookmark, a plot row, an image) made relative to
 * its root, or null when it is absolute, starts with ~, or climbs out of the
 * root at any step (docs/adr/0048).
 */
export const underRoot = (_root: string, p: string): string | null => {
  if (p.startsWith("/") || p.startsWith("~")) return null;
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part !== "..") out.push(part);
    else if (!out.length) return null;
    else out.pop();
  }
  return out.length ? out.join("/") : null;
};

/** A relative path given to golem or shem, never read as an option (docs/adr/0048). */
export const argPath = (p: string) => (p.startsWith("/") ? p : `./${p.replace(/^\.\//, "")}`);

/** `p` read from the folder `dir` inside `root`, as an absolute path that stays under the root, or null. */
export const within = (root: string, dir: string, p: string): string | null => {
  const from = dir === root ? "" : dir.startsWith(`${root}/`) ? `${dir.slice(root.length + 1)}/` : null;
  const r = from === null || p.startsWith("/") || p.startsWith("~") ? null : underRoot(root, from + p);
  return r ? `${root}/${r}` : null;
};
