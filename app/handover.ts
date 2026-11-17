// Handing the tree's files outside Aleph (docs/adr/0077): which rows go, when a drag has left the
// window, and the names a folder's zip gets. Pure functions; the native parts are in Rust.

/**
 * The paths a drag or a copy hands over: every selected row in the tree's order when the pressed
 * row is selected, else the pressed row alone (I6). `rows` are the paths of the rows shown now.
 */
export const handedOver = (pressed: string, selected: readonly string[], rows: readonly string[]): string[] =>
  selected.includes(pressed) ? rows.filter((p) => selected.includes(p)) : [pressed];

/** Whether a point in the page's coordinates is outside a window of that inner size. */
export const outsideWindow = (x: number, y: number, width: number, height: number) => x < 0 || y < 0 || x >= width || y >= height;

/** The zip's names for the names on disk: each paired with its NFC form (I3). */
export const zipNames = (names: readonly string[]): [string, string][] => names.map((n) => [n, n.normalize("NFC")]);
