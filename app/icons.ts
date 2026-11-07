// The icons the app uses, kept as SVG files in app/icons (lucide, ISC; docs/adr/0003).
const svgs = import.meta.glob("./icons/*.svg", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/** An inline icon as an HTML string. */
export const icon = (name: string, size = 16) => {
  const svg = svgs[`./icons/${name}.svg`] ?? svgs["./icons/circle-help.svg"];
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
