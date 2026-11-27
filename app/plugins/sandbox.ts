import runtime from "./frame.js?raw";
import type { PluginFrame, Spawn } from "./host.ts";

// Keep this hash in sync with frame.js and both Tauri CSP entries.
const FRAME_POLICY = "default-src 'none'; script-src 'sha256-GjTuWqcsbSZKZBwRCm2CEM/LpDbJCpiTgXucc/HtZ34=' blob:; connect-src 'none'; img-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

/** Start one plugin in a sandboxed frame with an opaque origin and one private port. */
export const spawnPlugin: Spawn = async (source, receive): Promise<PluginFrame> => {
  const frame = document.createElement("iframe");
  if (!frame.sandbox?.supports("allow-scripts")) throw new Error("sandbox を使えないためプラグインを起動できません");
  frame.sandbox.add("allow-scripts");
  frame.hidden = true;
  frame.setAttribute("aria-hidden", "true");
  if (/<\/script/i.test(runtime)) throw new Error("プラグインの起動コードを安全に埋め込めません");
  const channel = new MessageChannel();
  channel.port1.onmessage = ({ data }) => receive(data);
  channel.port1.start();
  frame.srcdoc = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${FRAME_POLICY}"><script>${runtime}</script>`;
  frame.onload = () => {
    frame.onload = null;
    frame.contentWindow?.postMessage({ type: "init", source }, "*", [channel.port2]);
  };
  document.body.append(frame);
  return {
    port: channel.port1,
    close: () => {
      channel.port1.close();
      channel.port2.close();
      frame.remove();
    },
  };
};
