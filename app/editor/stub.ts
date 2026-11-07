// An Editor for views that are not text (PDF, images, the plot): only destroy does anything.
import type { Editor } from "../ed/editor.ts";

export const stubEditor = (destroy: () => void, text: () => string = () => ""): Editor => ({
  edit: null,
  text,
  setText: () => {},
  goto: () => {},
  focus: () => {},
  setWidth: () => {},
  setInvisibles: () => {},
  setGrid: () => {},
  refreshMarks: () => {},
  setVertical: () => {},
  destroy,
});
