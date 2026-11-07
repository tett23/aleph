// A sample Aleph plugin (docs/adr/0017): the longest sentence of the open sheet
// in the status bar, and a command that tells its length.
const longest = (text) =>
  text
    .split(/[。！？\n]/)
    .map((s) => s.trim())
    .reduce((a, s) => ([...s].length > [...a].length ? s : a), "");

export const activate = (aleph) => {
  aleph.registerStatus((cur) => (cur && ["gm", "md", "txt"].includes(cur.kind) ? `最長の文 ${[...longest(cur.text)].length} 字` : ""));
  aleph.registerCommand("最長の文を見る", (cur) => cur && aleph.toast(`最長の文：${longest(cur.text)}`));
};
