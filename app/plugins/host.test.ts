import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { API_VERSION, createHost, type Current, type Spawn } from "./host.ts";

const src = (name: string) => ({ name, open: async () => ({ channel: name, source: readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8") }) });
const allow = { authorize: async () => true, close: async () => {} };
const current: Current = { path: "/w/p/chapters/01.gm", kind: "gm", text: "短い。これは少し長い文です。", project: "/w/p" };
type Rec = { version: number; saves: string[]; command?: string };
const recorded = globalThis as unknown as { recorded: Rec };
const eventually = async (check: () => boolean) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("プラグインの応答がありません");
};

/** A port-driven test frame. Browser sandboxing is checked separately. */
const spawn: Spawn = async (source, receive) => {
  const channel = new MessageChannel();
  channel.port1.onmessage = ({ data }) => receive(data);
  const commands = new Map<number, (value: Current) => unknown>();
  const statuses: ((value: Current) => string)[] = [];
  const saves: ((value: Current) => void)[] = [];
  const api = {
    version: API_VERSION,
    registerCommand: (label: string, run: (value: Current) => unknown) => {
      const id = commands.size + 1;
      commands.set(id, run);
      channel.port2.postMessage({ type: "register-command", id, label });
    },
    registerStatus: (render: (value: Current) => string) => statuses.push(render),
    onSave: (save: (value: Current) => void) => saves.push(save),
    toast: (text: string) => channel.port2.postMessage({ type: "toast", text }),
  };
  channel.port2.onmessage = async ({ data }) => {
    if (data.type === "saved") return void saves.forEach((save) => save(data.current));
    try {
      const value = data.type === "command"
        ? await commands.get(data.command)?.(data.current)
        : statuses.flatMap((render) => {
          try {
            return [render(data.current)];
          } catch {
            return [];
          }
        });
      channel.port2.postMessage({ type: "result", id: data.id, value });
    } catch (error) {
      channel.port2.postMessage({ type: "result", id: data.id, error: String(error) });
    }
  };
  void import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`).then(
    async (module) => {
      if (typeof module.activate !== "function") throw new Error("activate を書き出していません");
      await module.activate(api);
      channel.port2.postMessage({ type: "ready", hasStatus: statuses.length > 0, hasSaves: saves.length > 0 });
    },
  ).catch((error) => channel.port2.postMessage({ type: "failed", error: String(error) }));
  return { port: channel.port1, close: () => { channel.port1.close(); channel.port2.close(); } };
};

test("ADR 0115 I3: a plugin's command, status and save handler use its port", async () => {
  const toasts: string[] = [];
  const host = createHost((text) => toasts.push(text), () => {}, spawn, allow);
  const result = await host.load([src("records.js")], []);
  assert.deepEqual(result, [{ name: "records.js", state: "ok" }]);
  assert.equal(recorded.recorded.version, API_VERSION);
  assert.deepEqual(host.commands().map((command) => command.label), ["記録"]);
  await host.commands()[0].run(current);
  assert.equal(recorded.recorded.command, current?.path);
  host.status(current);
  await eventually(() => host.status(current).length === 1);
  assert.deepEqual(host.status(current), ["記録 gm"]);
  host.saved(current);
  await eventually(() => recorded.recorded.saves.length === 1);
  assert.deepEqual(recorded.recorded.saves, [current?.path]);
  host.close();
});

test("ADR 0115 I3: the sample plugin works through the port", async () => {
  const toasts: string[] = [];
  const host = createHost((text) => toasts.push(text), () => {}, spawn, allow);
  await host.load([src("longest-sentence.js")], []);
  host.status(current);
  await eventually(() => host.status(current).length === 1);
  assert.deepEqual(host.status(current), ["最長の文 10 字"]);
  await host.commands()[0].run(current);
  await eventually(() => toasts.length === 1);
  assert.deepEqual(toasts, ["最長の文：これは少し長い文です"]);
  host.close();
});

test("ADR 0115 I3: a failed plugin loses its registrations without stopping the others", async () => {
  const errors: string[] = [];
  const host = createHost(() => {}, (error) => errors.push(error), spawn, allow);
  const result = await host.load([src("throws.js"), src("no-activate.js"), src("syntax-error.js"), src("records.js")], []);
  assert.deepEqual(result.map((item) => item.state), ["failed", "failed", "failed", "ok"]);
  assert.match(result[0].error ?? "", /壊れています/);
  host.status(current);
  await eventually(() => host.status(current).length === 1);
  assert.deepEqual(host.status(current), ["記録 gm"]);
  assert.equal(errors.length, 3);
  host.close();
});

test("ADR 0115 I3: a disabled plugin is not started", async () => {
  let starts = 0;
  const host = createHost(() => {}, () => {}, async (source, receive) => {
    starts++;
    return spawn(source, receive);
  }, allow);
  const result = await host.load([{ name: "records.js", open: async () => assert.fail("a disabled plugin must not open a channel") }], ["records.js"]);
  assert.deepEqual(result, [{ name: "records.js", state: "disabled" }]);
  assert.equal(starts, 0);
  assert.deepEqual(host.commands(), []);
  host.close();
});

test("ADR 0115 I3: a handler failure leaves another plugin usable", async () => {
  const errors: string[] = [];
  const host = createHost(() => {}, (error) => errors.push(error), spawn, allow);
  await host.load([src("bad-handlers.js"), src("longest-sentence.js")], []);
  host.status(current);
  await eventually(() => host.status(current).length === 1);
  assert.deepEqual(host.status(current), ["最長の文 10 字"]);
  await host.commands()[0].run(current);
  assert.match(errors[0], /bad-handlers\.js.*command/);
  host.close();
});

test("ADR 0120 I1, ADR 0120 I2: plugin callbacks receive a sheet only after host authorization", async (t) => {
  const attempts: [string, string][] = [];
  let decide!: (allowed: boolean) => void;
  const decision = new Promise<boolean>((resolve) => { decide = resolve; });
  const access = {
    authorize: (channel: string, path: string) => {
      attempts.push([channel, path]);
      return decision;
    },
    close: async () => {},
  };
  let fromFrame!: (data: unknown) => void;
  const host = createHost(() => {}, () => {}, (source, receive) => {
    fromFrame = receive;
    return spawn(source, receive);
  }, access);
  t.after(() => host.close());
  await host.load([src("records.js")], []);
  const command = host.commands()[0].run(current);
  assert.deepEqual(host.status(current), []);
  host.saved(current);
  await eventually(() => attempts.length === 3 || recorded.recorded.command !== undefined);
  fromFrame({ type: "approve", channel: "records.js", path: current.path });
  assert.deepEqual(attempts, Array.from({ length: 3 }, () => ["records.js", current.path]));
  assert.equal(recorded.recorded.command, undefined);
  assert.deepEqual(recorded.recorded.saves, []);
  decide(true);
  await command;
  await eventually(() => host.status(current).length === 1 && recorded.recorded.saves.length === 1);
  assert.equal(recorded.recorded.command, current.path);
});

test("ADR 0120 I1: denial skips callbacks and a changed sheet discards a pending command", async (t) => {
  let decide!: (allowed: boolean) => void;
  const decision = new Promise<boolean>((resolve) => { decide = resolve; });
  const destinations: string[] = [];
  const host = createHost(() => {}, () => {}, spawn, {
    ...allow,
    authorize: (_channel, path) => {
      destinations.push(path);
      return path === current.path ? decision : Promise.resolve(false);
    },
  });
  t.after(() => host.close());
  await host.load([src("records.js")], []);
  let stillCurrent = true;
  const original = host.commands()[0].run(current, () => stillCurrent);
  stillCurrent = false;
  decide(true);
  await original;
  const other = { ...current, path: "/w/p/chapters/02.gm" };
  await host.commands()[0].run(other);
  host.status(other);
  host.saved(other);
  assert.deepEqual(destinations, [current.path, other.path, other.path, other.path]);
  assert.equal(recorded.recorded.command, undefined);
  assert.deepEqual(recorded.recorded.saves, []);
  assert.deepEqual(host.status(other), []);
});

test("ADR 0120 I1: absent subscriptions do not ask for sheet access", async (t) => {
  const requests: string[] = [];
  const host = createHost(() => {}, () => {}, spawn, {
    ...allow,
    authorize: async (_channel, path) => { requests.push(path); return false; },
  });
  t.after(() => host.close());
  await host.load([{ name: "commands.js", open: async () => ({ channel: "commands.js", source: "export const activate = (aleph) => aleph.registerCommand('run', () => {})" }) }], []);
  host.status(current);
  host.saved(current);
  assert.deepEqual(requests, []);
  await host.commands()[0].run(current);
  assert.deepEqual(requests, [current.path]);
});

test("ADR 0120 I1: a replaced load closes its late channel without starting the frame", async (t) => {
  const channels: string[] = [];
  let openOld!: (value: { channel: string; source: string }) => void;
  const pending = new Promise<{ channel: string; source: string }>((resolve) => { openOld = resolve; });
  const host = createHost(() => {}, () => {}, spawn, { ...allow, close: async (channel) => { channels.push(channel); } });
  t.after(() => host.close());
  const first = host.load([{ name: "stale.js", open: () => pending }], []);
  await host.load([src("records.js")], []);
  openOld({ channel: "stale", source: "" });
  await first;
  assert.deepEqual(channels, ["stale"]);
  assert.deepEqual(host.commands().map((c) => c.plugin), ["records.js"]);
});

test("ADR 0120 I5: revocation drops a pending status and leaves the current marker empty", async (t) => {
  let decide!: (allowed: boolean) => void;
  const decision = new Promise<boolean>((resolve) => { decide = resolve; });
  let authorization = 0;
  const host = createHost(() => {}, () => {}, spawn, {
    ...allow,
    authorize: () => { authorization++; return decision; },
  });
  t.after(() => host.close());
  await host.load([src("records.js")], []);
  host.status(current);
  host.clearStatus("records.js");
  decide(true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(host.status(current), []);
  assert.equal(authorization, 1);
});
