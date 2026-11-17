// The host's InstanceManager against the mock bridge, over real Unix
// sockets. (Inside an agent sandbox that forbids binding sockets, run with
// the sandbox off.)
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { InstanceSummary } from "../shared/host-contract";
import { InstanceManager, pidAlive } from "../host/manager";
// @ts-expect-error plain ESM test helper without types
import { startMockBridge } from "./mock-bridge/mock.mjs";

type Mock = Awaited<ReturnType<typeof startMockBridge>>;

const workspace = join(import.meta.dirname, "fixtures", "workspace");
let dir: string;
let mocks: Mock[];
let managers: InstanceManager[];
let signals: { at: number; instances: InstanceSummary[] }[];
let leases: number;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(read: () => T | undefined | null | false, timeoutMs = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting");
    await wait(20);
  }
}

async function mock(options: Record<string, unknown> = {}): Promise<Mock> {
  const created = await startMockBridge({ dir, workspace, open: ["main.go"], pid: process.pid, ...options });
  mocks.push(created);
  return created;
}

function manager(): InstanceManager {
  const created = new InstanceManager(dir, {
    emitState: (payload) => signals.push({ at: Date.now(), instances: payload.instances }),
    leaseWanted: (wanted) => {
      leases = wanted ? 1 : 0;
    },
  });
  managers.push(created);
  created.start();
  return created;
}

const connected = (m: InstanceManager) => m.list().find((i) => i.status === "connected");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir().length > 60 ? "/tmp" : tmpdir(), "hxb-"));
  mocks = [];
  managers = [];
  signals = [];
  leases = 0;
});

afterEach(async () => {
  for (const m of managers) m.dispose();
  for (const m of mocks) await m.stop().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
});

describe("discovery", () => {
  it("connects to a registered instance, says hello and reads its state", async () => {
    await mock({ env: { BB_THREAD_ID: "thr_abc", NOT_OURS: "x" } });
    const m = manager();
    const instance = await until(() => connected(m)?.focus?.path?.endsWith("main.go") && connected(m));
    expect(instance.protocol).toBe(1);
    expect(instance.capabilities).toContain("editor");
    expect(instance.commandPolicy).toBe("safe");
    expect(instance.env).toEqual({ BB_THREAD_ID: "thr_abc" });
    expect(instance.workspaceRoot).toBe(workspace);
    expect(leases).toBe(1);
  });

  it("removes a stale registry file whose process is gone", async () => {
    const dead = 999_999;
    expect(pidAlive(dead)).toBe(false);
    const registry = join(dir, `${dead}.json`);
    writeFileSync(registry, JSON.stringify({ protocol: 1, pid: dead, socket: join(dir, `${dead}.sock`), startedAt: "2026-11-16T00:00:00Z" }));
    const m = manager();
    await until(() => !existsSync(registry));
    expect(m.list()).toEqual([]);
  });

  it("ignores files that are not registry files", async () => {
    writeFileSync(join(dir, "junk.json"), "{ not json");
    writeFileSync(join(dir, "other.json"), JSON.stringify({ hello: 1 }));
    const m = manager();
    m.scan();
    expect(m.list()).toEqual([]);
  });

  it("drops an instance that exits and releases the worker lease", async () => {
    const bridge = await mock();
    const m = manager();
    await until(() => connected(m));
    await bridge.stop();
    m.scan();
    await until(() => m.list().length === 0);
    expect(leases).toBe(0);
  });

  it("marks a protocol it does not speak as incompatible", async () => {
    const m = new InstanceManager(dir, { emitState: () => {}, leaseWanted: () => {} });
    managers.push(m);
    // A second registry entry pointing at a socket that answers protocol 2.
    const { createServer } = await import("node:net");
    const sock = join(dir, "v2.sock");
    const server = createServer((socket) => {
      socket.setEncoding("utf8");
      socket.on("data", (line: string) => {
        const { id } = JSON.parse(line.trim().split("\n")[0]!);
        socket.write(JSON.stringify({ jsonrpc: "2.0", id, result: { protocol: 2, helixVersion: "future", pid: process.ppid, cwd: "/", workspaceRoot: "/", capabilities: [] } }) + "\n");
      });
    });
    await new Promise<void>((r) => server.listen(sock, r));
    writeFileSync(join(dir, `${process.ppid}.json`), JSON.stringify({ protocol: 2, pid: process.ppid, socket: sock }));
    m.start();
    const v2 = await until(() => m.list().find((i) => i.pid === process.ppid && i.status === "incompatible"));
    expect(v2.error).toMatch(/protocol 2/u);
    server.close();
  });
});

describe("events", () => {
  it("survives a flood of selection events with a handful of signals", async () => {
    const bridge = await mock();
    const m = manager();
    await until(() => connected(m)?.focus);
    signals.length = 0;
    const start = Date.now();
    bridge.control({ cmd: "flood", count: 20_000, perTick: 2000, intervalMs: 1 });
    await until(() => (connected(m)?.events ?? 0) >= 20_000, 10_000);
    await wait(400);
    const elapsed = Date.now() - start;
    // At most one signal per 150 ms, plus the trailing one.
    expect(signals.length).toBeLessThanOrEqual(Math.ceil(elapsed / 150) + 2);
    expect(connected(m)!.focus!.cursor!.line).toBe((19_999 % 400) + 1);
  });

  it("counts an overflow and resyncs after it", async () => {
    const bridge = await mock();
    const m = manager();
    await until(() => connected(m)?.focus);
    bridge.control({ cmd: "stall", ms: 300 });
    bridge.control({ cmd: "flood", count: 3000, perTick: 3000, intervalMs: 1 });
    const instance = await until(() => (connected(m)?.overflows ?? 0) > 0 && connected(m));
    expect(instance.dropped).toBeGreaterThan(0);
  });

  it("queues :bb-send events until they are acknowledged", async () => {
    const bridge = await mock();
    const m = manager();
    await until(() => connected(m)?.focus);
    bridge.control({ cmd: "select", line: 3, endLine: 5, endCol: 1 });
    expect(bridge.control({ cmd: "send", kind: "comment", note: "why?" }).ok).toBe(true);
    const sends = await until(() => m.pendingSends().length === 1 && m.pendingSends());
    expect(sends[0]!.event).toMatchObject({ kind: "comment", note: "why?", sendNow: false });
    expect((sends[0]!.event.ranges as { text: string }[])[0]!.text).toContain("\n");
    await until(() => connected(m)?.pendingSends === 1);
    expect(m.ackSends([sends[0]!.id])).toBe(0);
    expect(m.pendingSends()).toEqual([]);
  });

  it("tracks mode, diagnostics totals and language servers", async () => {
    const bridge = await mock();
    const m = manager();
    await until(() => connected(m)?.focus);
    bridge.control({ cmd: "mode", mode: "insert" });
    bridge.control({ cmd: "diagnostics", path: "main.go", errors: 2, warnings: 3 });
    bridge.control({ cmd: "lsp", state: "initialized" });
    const instance = await until(() => connected(m)?.diagnostics.errors === 2 && connected(m)?.mode === "insert" && connected(m));
    expect(instance.diagnostics).toEqual({ errors: 2, warnings: 3 });
    expect(instance.lspServers).toEqual(["mock-lsp"]);
  });
});

describe("calls", () => {
  it("answers, maps errors and times out with $/cancel", async () => {
    const bridge = await mock();
    const m = manager();
    const instance = await until(() => connected(m));
    const ok = await m.call(instance.id, "editor/open", { path: "main.go", line: 4 }, 2500);
    expect(ok).toMatchObject({ ok: true, result: { deferred: false } });
    const missing = await m.call(instance.id, "editor/open", { path: "nope.go" }, 2500);
    expect(missing).toMatchObject({ ok: false, error: { code: 1001, name: "not_found" } });
    const unknown = await m.call(instance.id, "editor/fly", {}, 2500);
    expect(unknown).toMatchObject({ ok: false, error: { name: "method_not_found" } });
    const refused = await m.call(instance.id, "editor/command", { typed: "sh ls" }, 2500);
    expect(refused).toMatchObject({ ok: false, error: { name: "unsupported", data: { reason: "runs a shell command" } } });
    bridge.control({ cmd: "slow", method: "editor/state", ms: 1500 });
    const slow = await m.call(instance.id, "editor/state", {}, 300);
    expect(slow).toMatchObject({ ok: false, error: { name: "timeout" } });
    await wait(50);
    expect(bridge.control({ cmd: "state" }).stats.requests).toBeGreaterThan(0);
    // The answer that arrives after the timeout is ignored; the next call works.
    bridge.control({ cmd: "slow", method: "editor/state", ms: 0 });
    expect(await m.call(instance.id, "editor/state", {}, 2500)).toMatchObject({ ok: true });
  });

  it("reports instances it does not know and ones that are not connected", async () => {
    const m = manager();
    expect(await m.call("12345", "editor/state", {}, 500)).toMatchObject({ ok: false, error: { name: "not_found" } });
  });

  it("reconnects after the editor drops the connection", async () => {
    const bridge = await mock();
    const m = manager();
    await until(() => connected(m));
    for (const client of bridge.clients) client.socket.destroy();
    await until(() => m.list()[0]?.status === "disconnected");
    const back = await until(() => connected(m), 5000);
    expect(back.status).toBe("connected");
  });

  it("is closed by the editor when a request line exceeds 8 MiB", async () => {
    await mock();
    const m = manager();
    const instance = await until(() => connected(m));
    const huge = "x".repeat(8 * 1024 * 1024 + 10);
    const result = await m.call(instance.id, "editor/status", { message: huge }, 3000);
    expect(result.ok).toBe(false);
    await until(() => connected(m), 5000);
  });
});
