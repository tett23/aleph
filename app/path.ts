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
