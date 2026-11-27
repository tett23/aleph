// Runs in one sandboxed, opaque-origin frame per Aleph plugin (ADR 0115).
const init = async (event) => {
  if (event.source !== window.parent || event.data?.type !== "init" || event.ports.length !== 1) return;
  window.removeEventListener("message", init);
  const port = event.ports[0];
  const source = event.data.source;
  if (typeof source !== "string") return;
  const report = (error) => port.postMessage({ type: "error", error: String(error) });
  if ("__TAURI_INTERNALS__" in globalThis || "__TAURI__" in globalThis || "ipc" in globalThis) {
    port.postMessage({ type: "failed", error: "隔離したフレームから Tauri IPC に届きます" });
    return;
  }
  try {
    void window.parent.document;
    port.postMessage({ type: "failed", error: "親画面の DOM に届きます" });
    return;
  } catch {
    // The sandbox gives this frame an opaque origin.
  }

  const commands = new Map();
  const statuses = [];
  const saves = [];
  let registering = true;
  const api = Object.freeze({
    version: 1,
    registerCommand(label, run) {
      if (!registering) throw new Error("起動後はコマンドを登録できません");
      if (typeof label !== "string" || typeof run !== "function") throw new Error("コマンドの登録が不正です");
      const id = commands.size + 1;
      commands.set(id, run);
      port.postMessage({ type: "register-command", id, label });
    },
    registerStatus(render) {
      if (!registering) throw new Error("起動後はステータスを登録できません");
      if (typeof render !== "function") throw new Error("ステータスの登録が不正です");
      statuses.push(render);
    },
    onSave(handler) {
      if (!registering) throw new Error("起動後は保存通知を登録できません");
      if (typeof handler !== "function") throw new Error("保存通知の登録が不正です");
      saves.push(handler);
    },
    toast(text) {
      if (typeof text === "string") port.postMessage({ type: "toast", text });
    },
  });

  try {
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    try {
      const module = await import(url);
      if (typeof module.activate !== "function") throw new Error("activate を書き出していません");
      await module.activate(api);
      registering = false;
    } finally {
      URL.revokeObjectURL(url);
    }
    port.postMessage({ type: "ready" });
  } catch (error) {
    port.postMessage({ type: "failed", error: String(error) });
    return;
  }

  port.onmessage = async ({ data }) => {
    if (!data || typeof data !== "object") return;
    if (data.type === "saved") {
      for (const save of saves) {
        try {
          await save(data.current);
        } catch (error) {
          report(error);
        }
      }
      return;
    }
    if (!Number.isSafeInteger(data.id)) return;
    try {
      const value = data.type === "command"
        ? await commands.get(data.command)?.(data.current)
        : data.type === "status"
          ? statuses.flatMap((render) => {
            try {
              const text = render(data.current);
              return typeof text === "string" && text ? [text] : [];
            } catch {
              return [];
            }
          })
          : undefined;
      port.postMessage({ type: "result", id: data.id, value });
    } catch (error) {
      port.postMessage({ type: "result", id: data.id, error: String(error) });
    }
  };
  port.start();
};
window.addEventListener("message", init);
