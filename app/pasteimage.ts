// Pasting an image from the clipboard (docs/adr/0031): what a paste is, the
// file's name, where it goes, and the reference put after the caret's line.
// Pure, so that node --test can run it.
import { projectOf } from "./workspace.ts";

/** Text wins over images (a web page copied with its pictures pastes as text). */
export const pasteKind = (text: string, types: string[]): "text" | "image" | "none" =>
  text ? "text" : types.some((t) => t.startsWith("image/")) ? "image" : "none";

/** Whether an image is drawn into a PNG before writing (@figure takes PNG, JPEG, SVG and PDF). */
export const toPng = (mime: string) => mime !== "image/png" && mime !== "image/jpeg";

const pad = (n: number) => String(n).padStart(2, "0");

/** pasted-YYYYMMDD-HHMMSS.png (.jpg for JPEG), in local time. */
export const pastedName = (d: Date, mime: string) =>
  `pasted-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${mime === "image/jpeg" ? "jpg" : "png"}`;

/** The folder the images are written to, and the reference's folder from the sheet (or the project); null where none. */
export const pastePlace = (path: string, kind: string, projects: string[]): { dir: string; ref: string } | null => {
  if (kind === "gm") {
    const p = projectOf(path, projects);
    return p ? { dir: `${p}/images`, ref: "images" } : null;
  }
  if (kind === "md") return { dir: `${path.slice(0, path.lastIndexOf("/"))}/images`, ref: "images" };
  return null;
};

/** Where and what to insert after 1-based `line`: an image line per image, blank lines around. */
export const mdImageInsert = (text: string, line: number, refs: string[]): { at: number; insert: string } => {
  let start = 0;
  for (let l = 1; l < line; l++) {
    const nl = text.indexOf("\n", start);
    if (nl < 0) break;
    start = nl + 1;
  }
  const nl = text.indexOf("\n", start);
  const at = nl < 0 ? text.length : nl + 1;
  const content = text.slice(start, nl < 0 ? text.length : nl);
  const pre = (nl < 0 ? "\n" : "") + (content.trim() ? "\n" : "");
  const body = refs.map((r) => `![${r.slice(r.lastIndexOf("/") + 1)}](${r})`).join("\n\n") + "\n";
  const nextEnd = text.indexOf("\n", at);
  const next = text.slice(at, nextEnd < 0 ? text.length : nextEnd);
  const post = at < text.length && next.trim() !== "" ? "\n" : "";
  return { at, insert: pre + body + post };
};
