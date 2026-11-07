// Key bindings like "Mod-Shift-z" (docs/adr/0019). A binding matches by the
// character or by the key's place (KeyboardEvent.code), since on macOS the
// option key changes the character ("Ï" for ⌥⇧F).

export type KeyEvent = { key: string; code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean };

export const isMac = () => typeof navigator !== "undefined" && /Mac/.test(navigator.platform);

export const matchKey = (binding: string, e: KeyEvent, mac = isMac()): boolean => {
  const parts = binding.split("-");
  const name = parts.pop()!;
  const mods = new Set(parts.map((p) => (p === "Mod" ? (mac ? "Meta" : "Ctrl") : p === "Cmd" ? "Meta" : p)));
  if (mods.has("Meta") !== e.metaKey || mods.has("Ctrl") !== e.ctrlKey || mods.has("Alt") !== e.altKey || mods.has("Shift") !== e.shiftKey) return false;
  if (name.length === 1) {
    const place = /[a-z]/i.test(name) ? `Key${name.toUpperCase()}` : /\d/.test(name) ? `Digit${name}` : null;
    return e.key.toLowerCase() === name.toLowerCase() || (place !== null && e.code === place);
  }
  return e.key === name || e.code === name;
};
