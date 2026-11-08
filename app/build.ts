// Whether this is a debug build, shown on the screen (docs/adr/0052).
import { invoke } from "@tauri-apps/api/core";

/** The build's kind, asked of Rust once: `tauri build --debug` is not `tauri dev`. */
export const debugBuild = (): Promise<boolean> => invoke<boolean>("debug_build").catch(() => false);

/** The mark at the left of the toolbar's title. */
export const devBadge = (debug: boolean) => (debug ? `<span class="devmark" data-tauri-drag-region>dev</span>` : "");

/** The version in the settings' header. */
export const versionLabel = (version: string, debug: boolean) => (debug ? (version ? `${version} (dev)` : "(dev)") : version);
