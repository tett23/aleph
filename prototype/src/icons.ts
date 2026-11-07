import * as L from "lucide-static";

const table = L as unknown as Record<string, string>;

const pascal = (name: string) =>
  name
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");

/** An inline lucide icon as an HTML string. */
export const icon = (name: string, size = 16) => {
  const svg = table[pascal(name)] ?? table.CircleHelp;
  return svg
    .replace(/width="24"/, `width="${size}"`)
    .replace(/height="24"/, `height="${size}"`)
    .replace(/class="[^"]*"/, 'class="ic"');
};

/** Builds an element from an HTML string. */
export const h = (html: string): HTMLElement => {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
};

export const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
