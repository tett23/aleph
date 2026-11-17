// The arguments the benchmark starts llama-server with. It listens on a UNIX
// socket only, like the app will (docs/adr/0081, I5): --host takes the path of
// a socket, and there is no --port.

export type ServerOptions = { model: string; socket: string; context: number; log: string };

export const serverArgs = (o: ServerOptions): string[] => {
  if (!o.socket.endsWith(".sock")) throw new Error(`the socket must end in .sock: ${o.socket}`);
  return [
    "--model", o.model,
    "--host", o.socket,
    "--ctx-size", String(o.context),
    // one slot, so that the whole context serves the one request
    "--parallel", "1",
    "--gpu-layers", "all",
    // no prompt cache in memory beyond the slot, so that the RSS is the model's
    "--cache-ram", "0",
    "--reasoning", "off",
    "--no-webui",
    "--log-file", o.log,
  ];
};

// The lines of llama-server's log that tell whether layers went to the GPU
export const gpuLines = (log: string): string[] =>
  log.split("\n").filter((l) => /layers? to GPU|using device|no usable GPU|ggml_metal_init|Metal/i.test(l)).map((l) => l.trim()).slice(0, 20);

export const offloaded = (log: string): { layers: number; of: number } | null => {
  const m = /offloaded (\d+)\/(\d+) layers to GPU/.exec(log);
  return m ? { layers: Number(m[1]), of: Number(m[2]) } : null;
};
