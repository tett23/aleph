// An Editor for views that are not text (PDF, images, the plot): only destroy does anything.
import type { Editor } from "./cm.ts";

export const stubEditor = (destroy: () => void, text: () => string = () => ""): Editor => ({
  view: null,
  text,
  setWidth: () => {},
  setInvisibles: () => {},
  setGrid: () => {},
  refreshMarks: () => {},
  goto: () => {},
  setText: () => {},
  destroy,
});
