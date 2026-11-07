// An example Aleph plugin: shows the longest sentence in the status bar,
// and adds a command that lists sentences over 80 characters.
// Copy it into the plugins folder shown in Settings > Aleph のプラグイン.

const sentences = (text) => text.split(/(?<=[。！？])/).map((s) => s.trim()).filter(Boolean);

export function activate(aleph) {
  aleph.registerStatus((cur) => {
    if (!cur || cur.kind !== "gm") return "";
    const max = Math.max(0, ...sentences(cur.text).map((s) => [...s].length));
    return `最長の文 ${max} 字`;
  });
  aleph.registerCommand("80 字を超える文を数える", (cur) => {
    if (!cur) return;
    const long = sentences(cur.text).filter((s) => [...s].length > 80);
    aleph.toast(long.length ? `${long.length} 文: ${long[0].slice(0, 30)}…` : "ありません");
  });
}
