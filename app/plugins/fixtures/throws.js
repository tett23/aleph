export const activate = (aleph) => {
  aleph.registerStatus(() => "消えるはず");
  throw new Error("壊れています");
};
