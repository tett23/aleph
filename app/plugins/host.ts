// Aleph's own plugins (docs/adr/0017): ES modules exporting activate(aleph).
// Each plugin's registrations are kept apart, so a plugin that fails is
// turned off alone, and a handler that throws is reported, not spread.

export const API_VERSION = 1;

/** The open sheet, as plugins see it: they cannot change the text. */
export type Current = { path: string; kind: string; text: string; project: string | null } | null;

export type AlephApi = {
  version: number;
  registerCommand: (label: string, run: (cur: Current) => void | Promise<void>) => void;
  registerStatus: (render: (cur: Current) => string) => void;
  onSave: (f: (cur: Current) => void) => void;
  toast: (msg: string) => void;
};

export type PluginFile = { name: string; source: string };
export type LoadResult = { name: string; state: "ok" | "disabled" | "failed"; error?: string };
type Owned<T> = { plugin: string; f: T };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const createHost = (toast: (msg: string) => void) => {
  let commands: Owned<{ label: string; run: (cur: Current) => void | Promise<void> }>[] = [];
  let status: Owned<(cur: Current) => string>[] = [];
  let saves: Owned<(cur: Current) => void>[] = [];
  const drop = (plugin: string) => {
    commands = commands.filter((x) => x.plugin !== plugin);
    status = status.filter((x) => x.plugin !== plugin);
    saves = saves.filter((x) => x.plugin !== plugin);
  };
  const apiFor = (plugin: string): AlephApi => ({
    version: API_VERSION,
    registerCommand: (label, run) => void commands.push({ plugin, f: { label, run } }),
    registerStatus: (render) => void status.push({ plugin, f: render }),
    onSave: (f) => void saves.push({ plugin, f }),
    toast,
  });

  return {
    /** Loads the plugins in order; `importer` turns a source into a module (a blob URL in the app). */
    load: async (files: PluginFile[], disabled: string[], importer: (source: string) => Promise<Record<string, unknown>>): Promise<LoadResult[]> => {
      const out: LoadResult[] = [];
      for (const { name, source } of files) {
        drop(name);
        if (disabled.includes(name)) {
          out.push({ name, state: "disabled" });
          continue;
        }
        try {
          const mod = await importer(source);
          if (typeof mod.activate !== "function") throw new Error("activate を書き出していません");
          await (mod.activate as (a: AlephApi) => unknown)(apiFor(name));
          out.push({ name, state: "ok" });
        } catch (e) {
          drop(name);
          out.push({ name, state: "failed", error: message(e) });
          toast(`プラグイン ${name} を読めません：${message(e)}`);
        }
      }
      return out;
    },
    commands: () =>
      commands.map(({ plugin, f }) => ({
        label: f.label,
        run: async (cur: Current) => {
          try {
            await f.run(cur);
          } catch (e) {
            toast(`プラグイン ${plugin} の「${f.label}」で誤りがありました：${message(e)}`);
          }
        },
      })),
    status: (cur: Current): string[] =>
      status.flatMap(({ f }) => {
        try {
          const s = f(cur);
          return s ? [s] : [];
        } catch {
          return [];
        }
      }),
    saved: (cur: Current) =>
      saves.forEach(({ plugin, f }) => {
        try {
          f(cur);
        } catch (e) {
          toast(`プラグイン ${plugin} の保存の処理で誤りがありました：${message(e)}`);
        }
      }),
  };
};
