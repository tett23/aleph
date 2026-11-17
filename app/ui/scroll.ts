// Keeping a scrolled element's position when a panel is drawn again with innerHTML:
// the element is replaced, and a new one starts at the top.

type Scrolled = { scrollTop: number; scrollLeft: number };
type Host = { querySelector?: (selector: string) => unknown };

const scrolled = (host: Host, selector: string): Scrolled | null =>
  (typeof host.querySelector === "function" ? (host.querySelector(selector) as Scrolled | null) : null) ?? null;

/** Runs `draw`, then puts the element matching `selector` back where the one before it was scrolled to. */
export const keepScroll = (host: Host, selector: string, draw: () => void) => {
  const before = scrolled(host, selector);
  const at = before ? { top: before.scrollTop, left: before.scrollLeft } : null;
  draw();
  const after = scrolled(host, selector);
  if (at && after) {
    after.scrollTop = at.top;
    after.scrollLeft = at.left;
  }
};
