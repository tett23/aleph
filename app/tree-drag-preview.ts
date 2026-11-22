// The floating tree item and its placement in the visible viewport (ADR 0103).
import { basename } from "./path.ts";

type Point = { x: number; y: number };
type Size = { width: number; height: number };

const inset = (span: number) => Math.min(4, span / 4);
export const previewSize = ({ width, height }: Size): Size => ({
  width: Math.min(240, width - 2 * inset(width)),
  height: height - 2 * inset(height),
});

const axisPosition = (pointer: number, size: number, span: number) => {
  const before = pointer - 12 - size;
  const after = pointer + 12;
  const min = inset(span);
  const max = span - min - size;
  return after <= max ? Math.max(min, after) : Math.max(min, Math.min(before, max));
};

export const previewPosition = (pointer: Point, size: Size, viewport: Size): Point => ({
  x: axisPosition(pointer.x, size.width, viewport.width),
  y: axisPosition(pointer.y, size.height, viewport.height),
});

export const mountTreeDragPreview = (row: HTMLElement, path: string) => {
  const preview = document.createElement("div");
  preview.className = "tree-drag-preview";
  preview.setAttribute("aria-hidden", "true");

  const content = document.createElement("div");
  content.className = "tree-drag-label";
  // A folder row starts with a disclosure chevron. Its kind icon follows it.
  const icon = row.querySelector(":scope > .ic.book") ?? row.querySelector(":scope > svg:last-of-type");
  if (icon) content.append(icon.cloneNode(true));
  const name = document.createElement("span");
  name.textContent = row.querySelector(":scope > .ttl")?.textContent ?? basename(path);
  content.append(name);
  const filename = row.querySelector(":scope > .fn")?.textContent;
  if (filename) {
    const detail = document.createElement("span");
    detail.className = "fn";
    detail.textContent = filename;
    content.append(detail);
  }
  const refuse = document.createElement("span");
  refuse.className = "tree-drag-refuse";
  refuse.textContent = "⊘";
  refuse.hidden = true;
  content.append(refuse);
  preview.append(content);
  document.body.append(preview);
  document.body.classList.add("tree-dragging");

  return {
    place({ x, y }: Point, forbidden: boolean) {
      refuse.hidden = !forbidden;
      const viewport = window.visualViewport ?? { offsetLeft: 0, offsetTop: 0, width: innerWidth, height: innerHeight };
      const { offsetLeft, offsetTop } = viewport;
      const limit = previewSize(viewport);
      preview.style.maxWidth = `${limit.width}px`;
      preview.style.maxHeight = `${limit.height}px`;
      const position = previewPosition({ x: x - offsetLeft, y: y - offsetTop }, preview.getBoundingClientRect(), viewport);
      preview.style.left = `${position.x + offsetLeft}px`;
      preview.style.top = `${position.y + offsetTop}px`;
    },
    remove: () => {
      preview.remove();
      document.body.classList.remove("tree-dragging");
    },
  };
};
