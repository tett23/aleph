// The scrolling of a tab bar wider than its pane (docs/adr/0107), as
// functions of plain numbers: positions are px from the start of the bar's
// content, the view is the bar's clientWidth (without the ＋).

/** The scrollLeft that shows a tab whole, moving the least; a tab wider than the view starts it (I1, I2). */
export const reveal = (o: { start: number; width: number; view: number; scroll: number }) => {
  if (o.width > o.view) return o.start;
  if (o.start < o.scroll) return o.start;
  if (o.start + o.width > o.scroll + o.view) return o.start + o.width - o.view;
  return o.scroll;
};

const LINE = 16;

/** How far a wheel moves the bar sideways: a vertical wheel over a bar that overflows, else nothing (I3). */
export const wheelAmount = (
  w: { dx: number; dy: number; mode: number },
  bar: { clientWidth: number; scrollWidth: number },
) => {
  const unit = w.mode === 1 ? LINE : w.mode === 2 ? bar.clientWidth : 1;
  const dx = w.dx * unit;
  const dy = w.dy * unit;
  if (Math.abs(dx) >= Math.abs(dy) || bar.scrollWidth <= bar.clientWidth) return 0;
  return dy;
};

/** The sides where tabs hide, with half a pixel for fractional widths (I4). */
export const edges = (b: { scrollLeft: number; clientWidth: number; scrollWidth: number }) => ({
  left: b.scrollLeft > 0.5,
  right: b.scrollLeft + b.clientWidth < b.scrollWidth - 0.5,
});

export const EDGE = 24;
export const STEP = 8;

/** The scroll of a frame while a tab is dragged at x: toward an edge within 24px of it (I5). */
export const dragScroll = (x: number, bar: { left: number; width: number }) => {
  const nearLeft = x <= bar.left + EDGE;
  const nearRight = x >= bar.left + bar.width - EDGE;
  if (nearLeft === nearRight) return 0;
  return nearLeft ? -STEP : STEP;
};
