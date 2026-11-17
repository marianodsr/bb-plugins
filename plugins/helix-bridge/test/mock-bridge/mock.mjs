#!/usr/bin/env node
// A mock Helix bridge that implements bb-bridge/PROTOCOL.md (version 1) over
// a Unix socket, for building and testing the plugin without the fork.
//
//   node test/mock-bridge/mock.mjs --dir <bridgeDir> --workspace <root> \
//     [--cwd <dir>] [--open a.go,b.go] [--env BB_THREAD_ID=thr_x,...] \
//     [--capabilities editor,reload,...] [--policy safe|all|none] \
//     [--pid <n>] [--control <socket>] [--test false]
//
// Writes <dir>/<pid>.json after the socket listens and removes both on a clean
// exit. A control socket (NDJSON, see ctl.mjs and README.md) drives the
// pretend user: select, edit, save, mode, send, diagnostics, flood, stall,
// slow, crash, exit.
import { chmodSync, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { BridgeError, ERR, Editor } from "./editor.mjs";

export const ALL_CAPABILITIES = ["editor", "reload", "locations", "views", "command", "diagnostics", "lsp", "applyEdits", "annotations"];
const EVENT_KINDS = ["selection", "documents", "diagnostics", "mode", "send", "lsp", "externalChange"];
const KIND_OF = {
  "event/selection": "selection",
  "event/documentOpened": "documents",
  "event/documentClosed": "documents",
  "event/documentChanged": "documents",
  "event/documentSaved": "documents",
  "event/focus": "documents",
  "event/diagnostics": "diagnostics",
  "event/mode": "mode",
  "event/send": "send",
  "event/lsp": "lsp",
  "event/externalChange": "externalChange",
};
/** Events the queue may drop when it overflows (all but send). */
const COALESCABLE = new Set(["event/selection", "event/documentChanged", "event/diagnostics", "event/mode", "event/focus"]);
const MAX_LINE = 8 * 1024 * 1024;
const QUEUE_LIMIT = 1024;
const EDITOR_TIMEOUT_MS = 2000;

export async function startMockBridge(options) {
  const pid = options.pid ?? process.pid;
  const dir = options.dir;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // macOS caps socket paths at 104 bytes: past 100, Helix moves the socket to
  // /tmp/helix-bridge-<uid>/; the registry's `socket` field is authoritative.
  let socketPath = join(dir, `${pid}.sock`);
  if (Buffer.byteLength(socketPath) > 100) {
    const fallback = join("/tmp", `helix-bridge-${process.getuid?.() ?? 0}`);
    mkdirSync(fallback, { recursive: true, mode: 0o700 });
    socketPath = join(fallback, `${pid}.sock`);
  }
  const registryPath = join(dir, `${pid}.json`);
  if (existsSync(socketPath)) unlinkSync(socketPath);
  const capabilities = options.capabilities ?? ALL_CAPABILITIES;
  const has = (cap) => capabilities.includes(cap);
  const editor = new Editor({ workspaceRoot: options.workspace, cwd: options.cwd, open: options.open ?? [] });
  const policy = options.policy ?? "safe";
  const slow = new Map(); // method -> delay ms
  const clients = new Set();
  const stats = { connections: 0, requests: 0, notificationsSent: 0, dropped: 0 };
  const log = options.log ?? (() => {});

  // ----- clients ------------------------------------------------------------

  function makeClient(socket) {
    const client = { socket, subs: new Set(), queue: [], dropped: 0, stalledUntil: 0, pending: new Map(), buffer: "", closed: false };
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      client.buffer += chunk;
      if (client.buffer.length > MAX_LINE && !client.buffer.includes("\n")) {
        log("line over 8 MiB, closing");
        socket.destroy();
        return;
      }
      let nl;
      while ((nl = client.buffer.indexOf("\n")) >= 0) {
        const line = client.buffer.slice(0, nl);
        client.buffer = client.buffer.slice(nl + 1);
        if (line.length > MAX_LINE) {
          socket.destroy();
          return;
        }
        if (line.trim()) handleLine(client, line);
      }
    });
    socket.on("close", () => {
      client.closed = true;
      for (const timer of client.pending.values()) clearTimeout(timer.timer);
      clients.delete(client);
    });
    socket.on("error", () => {});
    socket.on("drain", () => flush(client));
    clients.add(client);
    stats.connections += 1;
    return client;
  }

  function write(client, message) {
    if (client.closed) return false;
    return client.socket.write(JSON.stringify(message) + "\n");
  }

  function reply(client, id, result) {
    write(client, { jsonrpc: "2.0", id, result });
  }

  function fail(client, id, error) {
    const body = { code: error.code ?? -32603, message: error.message };
    if (error.data !== undefined) body.data = error.data;
    write(client, { jsonrpc: "2.0", id: id ?? null, error: body });
  }

  /** Queue an event; drop the oldest coalescable ones past the limit. */
  function enqueue(client, method, params) {
    client.queue.push({ method, params });
    while (client.queue.length > QUEUE_LIMIT) {
      const index = client.queue.findIndex((m) => COALESCABLE.has(m.method));
      if (index < 0) break;
      client.queue.splice(index, 1);
      client.dropped += 1;
      stats.dropped += 1;
    }
    flush(client);
  }

  function flush(client) {
    if (client.closed || Date.now() < client.stalledUntil) return;
    if (client.dropped > 0) {
      write(client, { jsonrpc: "2.0", method: "event/overflow", params: { dropped: client.dropped } });
      client.dropped = 0;
    }
    while (client.queue.length > 0) {
      const { method, params } = client.queue.shift();
      stats.notificationsSent += 1;
      if (!write(client, { jsonrpc: "2.0", method, params })) break; // wait for drain
    }
  }

  editor.on((method, params) => {
    const kind = KIND_OF[method];
    for (const client of clients) if (client.subs.has(kind)) enqueue(client, method, params);
  });

  // ----- requests -------------------------------------------------------------

  function handleLine(client, line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      fail(client, null, new BridgeError(ERR.parse, "not valid JSON"));
      return;
    }
    if (typeof message !== "object" || message === null || Array.isArray(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      fail(client, message?.id ?? null, new BridgeError(ERR.invalidRequest, "not a request object"));
      return;
    }
    if (message.method === "$/cancel") {
      const id = message.params?.id;
      const pending = client.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        client.pending.delete(id);
        fail(client, id, new BridgeError(ERR.cancelled, "cancelled"));
      }
      return;
    }
    if (message.id === undefined) return; // other notifications are ignored
    stats.requests += 1;
    const delay = slow.get(message.method) ?? slow.get("*") ?? 0;
    const isLsp = message.method.startsWith("lsp/");
    const limit = isLsp ? Math.min(60000, message.params?.timeoutMs ?? 10000) : EDITOR_TIMEOUT_MS;
    const run = () => {
      client.pending.delete(message.id);
      try {
        reply(client, message.id, dispatch(client, message.method, message.params ?? {}));
      } catch (error) {
        fail(client, message.id, error instanceof BridgeError ? error : new BridgeError(-32603, String(error?.message ?? error)));
      }
    };
    if (delay <= 0) return run();
    // A slow answer: the timeout wins when the delay exceeds it.
    const timer = setTimeout(() => {
      if (delay > limit) {
        client.pending.delete(message.id);
        fail(client, message.id, new BridgeError(ERR.timeout, `${message.method} did not answer in ${limit} ms`));
      } else run();
    }, Math.min(delay, limit));
    client.pending.set(message.id, { timer });
  }

  function need(cap) {
    if (!has(cap)) throw new BridgeError(ERR.methodNotFound, `method not found (capability ${cap} is off)`);
  }

  function dispatch(client, method, params) {
    switch (method) {
      case "bridge/hello":
        return { protocol: 1, helixVersion: "25.07.1 (mock)", pid, cwd: editor.cwd, workspaceRoot: editor.workspaceRoot, capabilities, commandPolicy: policy };
      case "events/subscribe":
      case "events/unsubscribe": {
        if (!Array.isArray(params.events)) throw new BridgeError(ERR.invalidParams, "events must be an array", { field: "events" });
        const unknown = params.events.find((e) => !EVENT_KINDS.includes(e));
        if (unknown !== undefined) throw new BridgeError(ERR.invalidParams, `unknown event kind ${unknown}`, { field: "events" });
        const kinds = params.events;
        for (const kind of kinds) method === "events/subscribe" ? client.subs.add(kind) : client.subs.delete(kind);
        return { subscribed: EVENT_KINDS.filter((k) => client.subs.has(k)) };
      }
      case "editor/state":
        need("editor");
        return editor.state();
      case "editor/open":
        need("editor");
        return editor.open(params);
      case "editor/text":
        need("editor");
        return editor.text(params);
      case "editor/selection":
        need("editor");
        return editor.selection();
      case "editor/status":
        need("editor");
        editor.status = { message: params.message, severity: params.severity ?? "info" };
        return {};
      case "editor/reload":
        need("reload");
        return editor.reload(params);
      case "editor/applyEdits":
        need("applyEdits");
        return editor.applyEdits(params);
      case "locations/set":
        need("locations");
        return editor.setLocations(params);
      case "locations/clear":
        need("locations");
        return editor.clearLocations(params);
      case "view/list":
        need("views");
        return editor.viewList();
      case "view/focus":
        need("views");
        return editor.viewFocus(params);
      case "view/close":
        need("views");
        return editor.viewClose(params);
      case "editor/select":
        need("views");
        return editor.select(params);
      case "editor/command":
        need("command");
        return editor.command(params, policy);
      case "annotations/set":
        need("annotations");
        return editor.annotate(params);
      case "diagnostics/get":
        need("diagnostics");
        return editor.getDiagnostics(params);
      case "lsp/servers":
        need("lsp");
        return editor.lspServers();
      case "lsp/query":
        need("lsp");
        return editor.query(params);
      default:
        throw new BridgeError(ERR.methodNotFound, `method not found: ${method}`);
    }
  }

  // ----- control ------------------------------------------------------------

  let flood = null;
  function control(command) {
    switch (command.cmd) {
      case "select":
        editor.touch();
        editor.userSelect(command);
        return { ok: true };
      case "edit":
        editor.touch();
        editor.userEdit(command.path);
        return { ok: true };
      case "save":
        editor.userSave(command.path);
        return { ok: true };
      case "mode":
        editor.setMode(command.mode);
        return { ok: true };
      case "busy":
        editor.touch();
        return { ok: true };
      case "send": {
        if (![...clients].some((c) => c.subs.has("send"))) return { ok: false, error: "no client is subscribed to send" };
        const params = editor.sendEvent(command);
        editor.emit("event/send", params);
        editor.status = { message: command.kind === "comment" ? "Comment added" : "Sent to bb", severity: "info" };
        return { ok: true, params };
      }
      case "diagnostics":
        editor.setDiagnostics(command.path, command);
        return { ok: true };
      case "externalChange":
        editor.emit("event/externalChange", { path: editor.abs(command.path), modified: true });
        return { ok: true };
      case "lsp":
        editor.lspRunning = command.state !== "exited";
        editor.emit("event/lsp", { id: 1, name: "mock-lsp", state: command.state });
        return { ok: true };
      case "flood": {
        // `count` selection events, `perTick` at a time, every `intervalMs`.
        const count = command.count ?? 10000;
        const perTick = command.perTick ?? 200;
        let sent = 0;
        clearInterval(flood);
        flood = setInterval(() => {
          for (let i = 0; i < perTick && sent < count; i += 1, sent += 1) {
            const view = editor.focused();
            view.selections = [{ start: { line: (sent % 400) + 1, col: 1 }, end: { line: (sent % 400) + 1, col: 1 } }];
            editor.emitSelection();
          }
          if (sent >= count) clearInterval(flood);
        }, command.intervalMs ?? 1);
        return { ok: true };
      }
      case "stall":
        // Pretend every client is slow: hold their queues for `ms`.
        for (const client of clients) client.stalledUntil = Date.now() + (command.ms ?? 2000);
        setTimeout(() => {
          for (const client of clients) flush(client);
        }, (command.ms ?? 2000) + 5);
        return { ok: true };
      case "slow":
        if (command.ms > 0) slow.set(command.method ?? "*", command.ms);
        else slow.delete(command.method ?? "*");
        return { ok: true };
      case "state":
        return { ok: true, state: editor.state(), status: editor.status, pendingJump: Boolean(editor.pendingJump), lists: Object.fromEntries([...editor.lists].map(([k, v]) => [k, v.items.length])), activeList: editor.activeList, annotations: [...editor.annotations.keys()].length, stats, clients: clients.size, views: editor.viewList() };
      case "go":
        return { ok: true, ...editor.go() };
      case "crash":
        // Exit without cleaning up: the registry file stays behind, stale.
        setTimeout(() => process.exit(1), 10);
        return { ok: true };
      case "exit":
        setTimeout(() => void stop().then(() => process.exit(0)), 10);
        return { ok: true };
      default:
        return { ok: false, error: `unknown command ${command.cmd}` };
    }
  }

  // ----- lifecycle ----------------------------------------------------------

  const server = createServer((socket) => makeClient(socket));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  chmodSync(socketPath, 0o600);
  const registry = {
    protocol: 1,
    pid,
    socket: socketPath,
    helixVersion: "25.07.1 (mock)",
    startedAt: new Date().toISOString().replace(/\.\d{3}Z$/u, "Z"),
    cwd: editor.cwd,
    workspaceRoot: editor.workspaceRoot,
    env: options.env ?? {},
    // Not part of PROTOCOL.md: marks a test instance so bb never maps it to a
    // thread through its workspace. It binds only through an explicit
    // BB_THREAD_ID or \`bb hx bind\`.
    ...(options.test === false ? {} : { test: true }),
  };
  const tmp = `${registryPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(registry, null, 2));
  renameSync(tmp, registryPath);

  let controlServer = null;
  if (options.control) {
    if (existsSync(options.control)) unlinkSync(options.control);
    controlServer = createServer((socket) => {
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        buffer += chunk;
        let nl;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          let out;
          try {
            out = control(JSON.parse(line));
          } catch (error) {
            out = { ok: false, error: String(error?.message ?? error) };
          }
          socket.write(JSON.stringify(out) + "\n");
        }
      });
      socket.on("error", () => {});
    });
    await new Promise((resolve) => controlServer.listen(options.control, resolve));
  }

  async function stop() {
    clearInterval(flood);
    for (const client of clients) client.socket.destroy();
    await new Promise((resolve) => server.close(() => resolve()));
    if (controlServer) await new Promise((resolve) => controlServer.close(() => resolve()));
    for (const path of [registryPath, socketPath]) if (existsSync(path)) unlinkSync(path);
  }

  return { pid, socketPath, registryPath, registry, editor, control, stats, clients, stop };
}

// ----- CLI --------------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i].replace(/^--/u, "");
    out[key] = argv[i + 1];
    i += 1;
  }
  return out;
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dir || !args.workspace) {
    console.error("usage: mock.mjs --dir <bridgeDir> --workspace <root> [--cwd] [--open a,b] [--env K=V,...] [--capabilities a,b] [--policy safe] [--pid n] [--control sock]");
    process.exit(2);
  }
  const env = Object.fromEntries((args.env ?? "").split(",").filter(Boolean).map((kv) => kv.split("=")));
  const mock = await startMockBridge({
    dir: args.dir,
    workspace: args.workspace,
    cwd: args.cwd,
    open: (args.open ?? "").split(",").filter(Boolean),
    env,
    capabilities: args.capabilities ? args.capabilities.split(",") : undefined,
    policy: args.policy,
    pid: args.pid ? Number(args.pid) : undefined,
    control: args.control,
    // `--test false`: behave like a real instance (mapped by workspace). Only
    // for a throwaway workspace that no real thread uses.
    test: args.test !== "false",
    log: (m) => console.error(`[mock] ${m}`),
  });
  console.log(JSON.stringify({ listening: mock.socketPath, registry: mock.registryPath, control: args.control ?? null }));
  const shutdown = () => void mock.stop().then(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
