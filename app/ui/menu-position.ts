type Size = { width: number; height: number };
type Origin = { left: number; top: number };
type Anchor = Origin & { bottom: number };

const margin = 4;
const gap = 4;

export const menuBounds = (viewport: Origin & Size): Origin & Size => {
  const x = viewport.width < 2 * margin ? 0 : margin;
  const y = viewport.height < 2 * margin ? 0 : margin;
  return {
    left: viewport.left + x,
    top: viewport.top + y,
    width: viewport.width - 2 * x,
    height: viewport.height - 2 * y,
  };
};

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(value, max));

export const menuPosition = (anchor: Anchor, measured: Size, bounds: Origin & Size): Origin => {
  const maxLeft = bounds.left + bounds.width - Math.min(measured.width, bounds.width);
  const height = Math.min(measured.height, bounds.height);
  const maxTop = bounds.top + bounds.height - height;
  const below = anchor.bottom + gap;
  const above = anchor.top - gap - height;
  const fits = (top: number) => top >= bounds.top && top <= maxTop;
  return {
    left: clamp(anchor.left, bounds.left, maxLeft),
    top: fits(below) ? below : fits(above) ? above : clamp(below, bounds.top, maxTop),
  };
};
