type Rect = { left: number; top: number; right: number; bottom: number };
export const hoverBounds = ({ left, top, width, height }: { left: number; top: number; width: number; height: number }) => {
  if (width <= 0 || height <= 0) return null;
  const x = Math.min(8, width / 4);
  const y = Math.min(8, height / 4);
  return { left: left + x, top: top + y, right: left + width - x, bottom: top + height - y, width: width - 2 * x, height: height - 2 * y };
};

export const hoverPosition = (bounds: Rect, mark: Rect, width: number, height: number) => {
  if (width > bounds.right - bounds.left || height > bounds.bottom - bounds.top) return null;
  const axis = (lo: number, hi: number, start: number, end: number, size: number) =>
    Math.min(hi - size, Math.max(lo, end + size <= hi ? end : start - size));
  return {
    left: axis(bounds.left, bounds.right, mark.left, mark.right, width),
    top: axis(bounds.top, bounds.bottom, mark.top, mark.bottom, height),
  };
};
