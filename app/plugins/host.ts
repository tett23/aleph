// Plugin messages cross an opaque-origin iframe boundary (ADR 0115).
export const API_VERSION = 1;

export type Current = { path: string; kind: string; text: string; project: string | null } | null;
export type PluginFile = { name: string; open: () => Promise<{ channel: string; source: string }> };
export type LoadResult = { name: string; state: "ok" | "disabled" | "failed"; error?: string };
export type PluginFrame = { port: MessagePort; close: () => void };
export type Spawn = (source: string, receive: (message: unknown) => void) => Promise<PluginFrame>;
type Access = { authorize: (channel: string, path: string) => Promise<boolean>; close: (channel: string) => Promise<void> };

type Reply = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
type Plugin = {
  name: string;
  channel: string;
  frame: PluginFrame | null;
  commandEntries: { id: number; label: string }[];
  statusKey: string | null;
  statusRevision: number;
  status: string[];
  hasStatus: boolean;
  hasSaves: boolean;
  approvalRevision: number;
  closed: boolean;
  ready: boolean;
  settleStart: (error?: string) => void;
  replies: Map<number, Reply>;
  nextId: number;
};

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const alwaysCurrent = () => true;

export const createHost = (toast: (text: string) => void, fail: (text: string) => void, spawn: Spawn, access: Access, changed: () => void = () => {}) => {
  let plugins: Plugin[] = [];

  const closeChannel = (channel: string) => void access.close(channel).catch(() => {});
  const close = (plugin: Plugin) => {
    if (plugin.closed) return;
    plugin.closed = true;
    plugin.settleStart();
    for (const reply of plugin.replies.values()) {
      clearTimeout(reply.timer);
      reply.reject(new Error("プラグインを閉じました"));
    }
    plugin.replies.clear();
    plugin.frame?.close();
    plugin.frame = null;
    closeChannel(plugin.channel);
  };

  const reset = () => {
    const previous = plugins;
    plugins = [];
    previous.forEach(close);
    return plugins;
  };

  // The iframe sees neither the channel ID nor sheet data while Rust is deciding.
  const sendCurrent = async <T>(plugin: Plugin, current: Current, stillCurrent: () => boolean, send: (frame: PluginFrame) => T) => {
    const frame = plugin.frame;
    if (!frame || !stillCurrent()) return;
    const approvalRevision = plugin.approvalRevision;
    if (current && !await access.authorize(plugin.channel, current.path)) return;
    if (plugin.frame === frame && plugin.approvalRevision === approvalRevision && stillCurrent()) return send(frame);
  };

  const request = (plugin: Plugin, frame: PluginFrame, type: "command" | "status", values: Record<string, unknown>): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = ++plugin.nextId;
      const timer = setTimeout(() => {
        plugin.replies.delete(id);
        reject(new Error("プラグインの応答がありません"));
      }, 30_000);
      plugin.replies.set(id, { resolve, reject, timer });
      frame.port.postMessage({ type, id, ...values });
    });

  const receive = (plugin: Plugin, value: unknown) => {
    if (plugin.closed || !value || typeof value !== "object") return;
    const data = value as Record<string, unknown>;
    if (!plugin.ready && data.type === "register-command" && typeof data.id === "number" && Number.isSafeInteger(data.id) && typeof data.label === "string") {
      plugin.commandEntries.push({ id: data.id, label: data.label });
      return;
    }
    if (data.type === "toast" && typeof data.text === "string") return toast(data.text);
    if (data.type === "error" && typeof data.error === "string") return fail(`プラグイン ${plugin.name} で誤りがありました：${data.error}`);
    if (data.type === "ready" && !plugin.ready) {
      plugin.ready = true;
      plugin.hasStatus = data.hasStatus === true;
      plugin.hasSaves = data.hasSaves === true;
      return plugin.settleStart();
    }
    if (data.type === "failed" && typeof data.error === "string") return plugin.settleStart(data.error);
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
      const batch = reset();
      const results: LoadResult[] = [];
      for (const { name, open } of files) {
        if (plugins !== batch) break;
        if (disabled.includes(name)) {
          results.push({ name, state: "disabled" });
          continue;
        }
        let plugin: Plugin | undefined;
        try {
          const { channel, source } = await open();
          if (plugins !== batch) {
            closeChannel(channel);
            break;
          }
          let settleStart!: Plugin["settleStart"];
          const ready = new Promise<string | undefined>((resolve) => { settleStart = resolve; });
          const loading: Plugin = {
            name, channel, frame: null, commandEntries: [], statusKey: null, statusRevision: 0, status: [],
            hasStatus: false, hasSaves: false, approvalRevision: 0, closed: false, ready: false,
            settleStart, replies: new Map(), nextId: 0,
          };
          plugin = loading;
          batch.push(loading);
          const frame = await spawn(source, (value) => receive(loading, value));
          if (loading.closed) {
            frame.close();
            break;
          }
          loading.frame = frame;
          let timer: ReturnType<typeof setTimeout>;
          try {
            const error = await Promise.race([ready, new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("プラグインの起動が時間切れです")), 10_000);
            })]);
            if (loading.closed) break;
            if (error !== undefined) throw new Error(error);
          } finally {
            clearTimeout(timer!);
          }
          results.push({ name, state: "ok" });
        } catch (error) {
          if (plugin) close(plugin);
          if (plugins !== batch) break;
          results.push({ name, state: "failed", error: message(error) });
          fail(`プラグイン ${name} を読めません：${message(error)}`);
        }
      }
      if (plugins === batch) changed();
      return results;
    },
    commands: () => plugins.filter((plugin) => plugin.ready && plugin.frame).flatMap((plugin) => plugin.commandEntries.map((command) => ({
      plugin: plugin.name,
      label: command.label,
      run: async (current: Current, stillCurrent = alwaysCurrent) => {
        try {
          await sendCurrent(plugin, current, stillCurrent, (frame) => request(plugin, frame, "command", { command: command.id, current }));
        } catch (error) {
          if (!plugin.closed) fail(`プラグイン ${plugin.name} の「${command.label}」で誤りがありました：${message(error)}`);
        }
      },
    }))),
    status: (current: Current): string[] => {
      const key = JSON.stringify(current);
      for (const plugin of plugins) {
        if (!plugin.frame || !plugin.hasStatus || plugin.statusKey === key) continue;
        plugin.statusKey = key;
        plugin.status = [];
        const revision = ++plugin.statusRevision;
        const stillCurrent = () => !plugin.closed && plugin.statusRevision === revision;
        void sendCurrent(plugin, current, stillCurrent, (frame) => request(plugin, frame, "status", { current })).then((value) => {
          if (!stillCurrent() || !Array.isArray(value)) return;
          plugin.status = value.filter((text): text is string => typeof text === "string" && text.length > 0);
          changed();
        }).catch(() => {});
      }
      return plugins.flatMap((plugin) => plugin.status);
    },
    saved: (current: Current, stillCurrent = alwaysCurrent) => {
      for (const plugin of plugins) {
        if (!plugin.hasSaves) continue;
        void sendCurrent(plugin, current, stillCurrent, (frame) => frame.port.postMessage({ type: "saved", current })).catch(() => {});
      }
    },
    clearStatus: (name?: string) => {
      for (const plugin of plugins) {
        if (name !== undefined && plugin.name !== name) continue;
        plugin.approvalRevision++;
        plugin.statusRevision++;
        plugin.status = [];
      }
      changed();
    },
    close: () => { reset(); },
  };
};
