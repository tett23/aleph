export const activate = (aleph) => {
  aleph.registerStatus(() => {
    throw new Error("status");
  });
  aleph.registerCommand("落ちる", () => {
    throw new Error("command");
  });
};
