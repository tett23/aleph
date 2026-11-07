// Remote images taken out of a diagram Mermaid drew (docs/adr/0047): an
// `image` with an external href, and an `img` in a label with an external src.
// The CSP's img-src stops what this misses.

const remote = (v: string) => /^\s*([a-z][a-z0-9+.-]*:|\/\/)/i.test(v) && !/^\s*data:/i.test(v);

const ATTR = /\b(?:xlink:href|href|src)\s*=\s*("([^"]*)"|'([^']*)')/i;

export const stripRemoteImages = (svg: string) =>
  svg
    .replace(/<image\b[^>]*?(?:\/>|>[\s\S]*?<\/image>)/gi, (m) => {
      const a = ATTR.exec(m);
      return a && remote(a[2] ?? a[3] ?? "") ? "" : m;
    })
    .replace(/<img\b[^>]*>/gi, (m) => {
      const a = ATTR.exec(m);
      return a && remote(a[2] ?? a[3] ?? "") ? "" : m;
    });
