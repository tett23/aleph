// A refresh in flight may never replace a newer HEAD read, even if it finishes later.
export const createDiffSource = (read: () => Promise<string | null | false>) => {
  let current: Promise<string | null | false> | undefined;
  return {
    get: (reset: boolean) => {
      if (reset || !current) current = read().catch(() => false as const);
      const request = current;
      return async () => {
        const base = await request;
        return request === current ? base : undefined;
      };
    },
    invalidate: () => { current = undefined; },
  };
};
