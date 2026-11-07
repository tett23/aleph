// Aleph's own plugins: ES modules in the app's plugins folder that export activate(aleph).
import { api, basename } from "./api";
import { config, saveConfig } from "./config";

export type Current = { path: string; kind: string; text: string; project: string | null } | null;

export type AlephApi = {
  registerCommand: (label: string, run: (cur: Current) => void | Promise<void>) => void;
  registerStatus: (render: (cur: Current) => string) => void;
  onSave: (f: (cur: Current) => void) => void;
  toast: (msg: string) => void;
};

export const registry = {
  commands: [] as { label: string; run: (cur: Current) => void | Promise<void> }[],
  status: [] as ((cur: Current) => string)[],
  save: [] as ((cur: Current) => void)[],
};

export const loadPlugins = async (toast: (m: string) => void) => {
  const dir = await api.pluginsDir();
  const files = (await api.listDir(dir)).filter((p) => p.endsWith(".js")).sort();
  config.plugins = files.map(basename);
  await saveConfig();
  const aleph: AlephApi = {
    registerCommand: (label, run) => registry.commands.push({ label, run }),
    registerStatus: (render) => registry.status.push(render),
    onSave: (f) => registry.save.push(f),
    toast,
  };
  for (const f of files) {
    try {
      const url = URL.createObjectURL(new Blob([await api.readText(f)], { type: "text/javascript" }));
      const mod = await import(/* @vite-ignore */ url);
      await mod.activate?.(aleph);
    } catch (e) {
      toast(`プラグイン ${basename(f)} を読めません: ${e}`);
    }
  }
};
