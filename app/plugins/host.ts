// Plugin messages cross an opaque-origin iframe boundary (ADR 0115).
export const API_VERSION = 1;

export type Current = { path: string; kind: string; text: string; project: string | null } | null;
export type PluginFile = { name: string; source: string };
export type LoadResult = { name: string; state: "ok" | "disabled" | "failed"; error?: string };
export type PluginFrame = { port: MessagePort; close: () => void };
export type Spawn = (source: string, receive: (message: unknown) => void) => Promise<PluginFrame>;

type Reply = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
type Plugin = {
  name: string;
  frame: PluginFrame | null;
  commandEntries: { id: number; label: string }[];
  statusKey: string | null;
  status: string[];
  ready: boolean;
  replies: Map<number, Reply>;
  nextId: number;
};

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export const createHost = (toast: (text: string) => void, fail: (text: string) => void, spawn: Spawn, changed: () => void = () => {}) => {
  let plugins: Plugin[] = [];

  const close = (plugin: Plugin) => {
    for (const reply of plugin.replies.values()) {
      clearTimeout(reply.timer);
      reply.reject(new Error("プラグインを閉じました"));
    }
    plugin.replies.clear();
    plugin.frame?.close();
    plugin.frame = null;
  };

  const request = (plugin: Plugin, type: "command" | "status", values: Record<string, unknown>): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (!plugin.frame) return reject(new Error("プラグインを閉じました"));
      const id = ++plugin.nextId;
      const timer = setTimeout(() => {
        plugin.replies.delete(id);
        reject(new Error("プラグインの応答がありません"));
      }, 30_000);
      plugin.replies.set(id, { resolve, reject, timer });
      plugin.frame.port.postMessage({ type, id, ...values });
    });

  const receive = (plugin: Plugin, value: unknown, ready: (error?: string) => void) => {
    if (!value || typeof value !== "object") return;
    const data = value as Record<string, unknown>;
    if (!plugin.ready && data.type === "register-command" && typeof data.id === "number" && Number.isSafeInteger(data.id) && typeof data.label === "string") {
      plugin.commandEntries.push({ id: data.id, label: data.label });
      return;
    }
    if (data.type === "toast" && typeof data.text === "string") return toast(data.text);
    if (data.type === "error" && typeof data.error === "string") return fail(`プラグイン ${plugin.name} で誤りがありました：${data.error}`);
    if (data.type === "ready") {
      plugin.ready = true;
      return ready();
    }
    if (data.type === "failed" && typeof data.error === "string") return ready(data.error);
    if (data.type !== "result" || typeof data.id !== "number") return;
    const reply = plugin.replies.get(data.id);
    if (!reply) return;
    plugin.replies.delete(data.id);
    clearTimeout(reply.timer);
    if (typeof data.error === "string") reply.reject(new Error(data.error));
    else reply.resolve(data.value);
  };

  return {
    load: async (files: PluginFile[], disabled: string[]): Promise<LoadResult[]> => {
      plugins.forEach(close);
      plugins = [];
      const results: LoadResult[] = [];
      for (const { name, source } of files) {
        if (disabled.includes(name)) {
          results.push({ name, state: "disabled" });
          continue;
        }
        const plugin: Plugin = { name, frame: null, commandEntries: [], statusKey: null, status: [], ready: false, replies: new Map(), nextId: 0 };
        try {
          let settle = (_error?: string) => {};
          const ready = new Promise<void>((resolve, reject) => {
            settle = (error) => error ? reject(new Error(error)) : resolve();
          });
          plugin.frame = await spawn(source, (value) => receive(plugin, value, settle));
          let timer: ReturnType<typeof setTimeout>;
          try {
            await Promise.race([ready, new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("プラグインの起動が時間切れです")), 10_000);
            })]);
          } finally {
            clearTimeout(timer!);
          }
          plugins.push(plugin);
          results.push({ name, state: "ok" });
        } catch (error) {
          close(plugin);
          results.push({ name, state: "failed", error: message(error) });
          fail(`プラグイン ${name} を読めません：${message(error)}`);
        }
      }
      changed();
      return results;
    },
    commands: () => plugins.flatMap((plugin) => plugin.commandEntries.map((command) => ({
      plugin: plugin.name,
      label: command.label,
      run: async (current: Current) => {
        try {
          await request(plugin, "command", { command: command.id, current });
        } catch (error) {
          fail(`プラグイン ${plugin.name} の「${command.label}」で誤りがありました：${message(error)}`);
        }
      },
    }))),
    status: (current: Current): string[] => {
      const key = JSON.stringify(current);
      for (const plugin of plugins) {
        if (plugin.statusKey === key) continue;
        plugin.statusKey = key;
        plugin.status = [];
        void request(plugin, "status", { current }).then((value) => {
          if (plugin.statusKey !== key || !Array.isArray(value)) return;
          plugin.status = value.filter((text): text is string => typeof text === "string" && text.length > 0);
          changed();
        }).catch(() => {});
      }
      return plugins.flatMap((plugin) => plugin.status);
    },
    saved: (current: Current) => {
      for (const plugin of plugins) plugin.frame?.port.postMessage({ type: "saved", current });
    },
    close: () => {
      plugins.forEach(close);
      plugins = [];
    },
  };
};
