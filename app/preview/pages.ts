// The page preview's resolution: the page's width from style.toml, and the dpi
// that fills the pane on this screen at this zoom (docs/adr/0010).

const UNIT: Record<string, number> = { mm: 1 / 25.4, pt: 1 / 72, Q: 0.25 / 25.4, H: 0.25 / 25.4, in: 1 };

/** A length in Golem's units (mm, pt, Q, H, in) as inches; null when it is not one. */
export const lengthInches = (s: string): number | null => {
  const m = /^\s*([\d.]+)\s*(mm|pt|Q|H|in)\s*$/.exec(s);
  return m ? Number(m[1]) * UNIT[m[2]] : null;
};

// the widths of the sizes Golem names, in inches (Golem's specification, [page] size)
const NAMED: Record<string, number> = {
  A4: 210 / 25.4,
  A5: 148 / 25.4,
  A6: 105 / 25.4,
  B5: 182 / 25.4,
  B6: 128 / 25.4,
  四六判: 127 / 25.4,
  菊判: 150 / 25.4,
  新書判: 103 / 25.4,
  "mass-market": 4.25,
};

/** The lines of a TOML table, up to the next header. */
const table = (toml: string, name: string): string[] => {
  const lines = toml.split("\n");
  const start = lines.findIndex((l) => l.trim() === `[${name}]`);
  if (start < 0) return [];
  const end = lines.findIndex((l, i) => i > start && /^\s*\[/.test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end);
};

const value = (lines: string[], key: string) => lines.map((l) => new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*(#.*)?$`).exec(l)?.[1]).find(Boolean);

/** The width of the PDF's page in inches: the trim size and the bleed on both sides; A5 when not written. */
export const pageInches = (styleToml: string): number => {
  const page = table(styleToml, "page");
  const size = value(page, "size") ?? "";
  const named = /^"([^"]+)"$/.exec(size)?.[1];
  const width = named ? NAMED[named] : lengthInches(/width\s*=\s*"([^"]+)"/.exec(size)?.[1] ?? "");
  const bleed = lengthInches(/^"([^"]+)"$/.exec(value(page, "bleed") ?? "")?.[1] ?? "") ?? 0;
  return (width ?? NAMED.A5) + 2 * bleed;
};

export type DpiInput = {
  /** The pane's width in CSS pixels. */
  width: number;
  /** devicePixelRatio. */
  ratio: number;
  zoom: number;
  inches: number;
  /** The dpi fixed in the settings; 0 or absent for automatic. */
  fixed?: number;
  /** The pane's padding, left and right together. */
  padding?: number;
};

export const MIN_DPI = 72;
export const MAX_DPI = 1200;

/** The dpi whose pixels fill the page's width exactly; zooming out keeps the pane's. */
export const autoDpi = ({ width, ratio, zoom, inches, fixed = 0, padding = 36 }: DpiInput): number =>
  fixed > 0 ? fixed : Math.min(MAX_DPI, Math.max(MIN_DPI, Math.ceil(((width - padding) * ratio * Math.max(1, zoom)) / inches)));
