// Registers one of each, for the tests.
export const activate = (aleph) => {
  globalThis.recorded = { version: aleph.version, saves: [] };
  aleph.registerCommand("記録", (cur) => (globalThis.recorded.command = cur?.path));
  aleph.registerStatus((cur) => `記録 ${cur?.kind}`);
  aleph.onSave((cur) => globalThis.recorded.saves.push(cur?.path));
};
