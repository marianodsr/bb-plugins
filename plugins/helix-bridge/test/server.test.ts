// The server end to end in-process: bb's fake plugin host, its host-RPC
// driver wired to a real InstanceManager, and the mock bridge behind it.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFakePluginHost,
  makeHostResponse,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InstanceManager } from "../host/manager";
import plugin from "../server";
import { parseLocation } from "../server/cli";
import { hunksFromDiff } from "../server/follow";
import { selectionBlock } from "../server/sends";
import { TOOL_NAMES } from "../server/tools";
import { commentItems, type ReviewComment } from "../server/annotations";
import { editedPaths, revealOf } from "../server/watch";
import { OPENER_SCRIPT, treeYaziToml } from "../host/yazi";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
import { chmodSync, readFileSync } from "node:fs";
import { treeClientId } from "../server/tree";
// @ts-expect-error plain ESM test helper without types
import { ALL_CAPABILITIES, startMockBridge } from "./mock-bridge/mock.mjs";

const workspace = join(import.meta.dirname, "fixtures", "workspace");
const HOST = "host_test";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(read: () => T | undefined | null | false | Promise<T | undefined | null | false>, timeoutMs = 4000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting");
    await wait(25);
  }
}

let dir: string;
let mock: Awaited<ReturnType<typeof startMockBridge>>;
let manager: InstanceManager;
let fake: ReturnType<typeof createFakePluginHost>;
let sent: { threadId: string; text: string }[];
let reconcile: { controller: AbortController; done: Promise<void> };

const textOf = (result: unknown) => ((result as { content: { text: string }[] }).content ?? []).map((c) => c.text).join("\n");

async function teardown() {
  reconcile.controller.abort();
  await reconcile.done.catch(() => {});
  await fake.harness.lifecycle.dispose();
  manager.dispose();
  await mock.stop();
  rmSync(dir, { recursive: true, force: true });
}

let capabilities: string[] | null = null;
async function setupWithCapabilities(caps: string[]) {
  capabilities = caps;
  try {
    await setup();
  } finally {
    capabilities = null;
  }
}

async function setup(env: Record<string, string> = { BB_THREAD_ID: "thr_term" }, extraSdk: Record<string, Record<string, unknown>> = {}) {
  dir = mkdtempSync(join(tmpdir().length > 60 ? "/tmp" : tmpdir(), "hxs-"));
  mock = await startMockBridge({ dir, workspace, open: ["main.go"], pid: process.pid, env, ...(capabilities ? { capabilities } : {}) });
  sent = [];
  fake = createFakePluginHost({
    pluginId: "helix-bridge",
    agentSkillIds: ["helix-bridge"],
    settings: { bridgeDir: dir },
    sdk: {
      hosts: { list: async () => [makeHostResponse({ id: HOST, status: "connected" })] },
      environments: {
        list: async () => [{ id: "env_test", hostId: HOST, path: workspace }] as never,
        get: async ({ environmentId }: { environmentId: string }) => ({ id: environmentId, hostId: HOST, path: environmentId === "env_test" ? workspace : "/elsewhere" }) as never,
      },
      threads: {
        // thr_nobody lives in another environment; every other thread in env_test.
        get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, environmentId: threadId === "thr_nobody" ? "env_other" : "env_test", title: `Thread ${threadId}` }),
        list: async () => [makeThreadResponse({ id: "thr_env", environmentId: "env_test" })],
        send: async (args: { threadId: string; input: { text: string }[] }) => {
          sent.push({ threadId: args.threadId, text: args.input[0]!.text });
          return {} as never;
        },
      },
      plugins: { list: async () => [] as never, ...extraSdk.plugins },
      system: { config: async () => ({ primaryHostId: HOST }) as never },
    } as never,
    experimental_callHostRpc: async ({ method, input }) => {
      const args = input as Record<string, unknown>;
      switch (method) {
        case "instances":
          manager.scan();
          return { bridgeDir: dir, dirExists: true, instances: manager.list() };
        case "call":
          return manager.call(String(args.instanceId), String(args.method), args.params as Record<string, unknown>, Number(args.timeoutMs ?? 2500));
        case "pendingSends":
          return { sends: manager.pendingSends() };
        case "ackSends":
          return { remaining: manager.ackSends(args.ids as string[]) };
        default:
          throw new Error(`unexpected host call ${method}`);
      }
    },
  });
  manager = new InstanceManager(dir, {
    emitState: (payload) => void fake.harness.behavior.experimental_emitHostSignal(HOST, "state", payload),
    leaseWanted: () => {},
  });
  manager.start();
  await until(() => manager.list()[0]?.status === "connected");
  await plugin(fake.bb);
  reconcile = fake.harness.behavior.runService("reconcile");
  await until(async () => (await fake.harness.behavior.runCli(["list"])).stdout.includes("pid"));
}

beforeEach(async () => {
  await setup();
});

afterEach(async () => {
  await teardown();
});

const names = (tools: readonly unknown[]) => tools.map((t) => (typeof t === "string" ? t : (t as { name: string }).name));

describe("instances and bindings", () => {
  it("lists the instance bound to the thread whose terminal started it", async () => {
    const out = await fake.harness.behavior.runCli(["list"]);
    expect(out.stdout).toMatch(/thr_term "Thread thr_term" \(terminal\)/u);
    const state = await fake.harness.behavior.runCli(["state"], { threadId: "thr_term" });
    expect(state.stdout).toMatch(/bound by its bb terminal/u);
    expect(state.stdout).toMatch(/command policy: safe/u);
  });

  it("offers the tools only to a thread a connected Helix serves", async () => {
    const served = await fake.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ thread: { id: "thr_term" } as never, environment: { id: "env_other", path: "/elsewhere" } as never }),
    );
    // helix_edit only with the toolEdit setting: agents edit files, Helix shows it.
    expect(names(served.tools)).toEqual(TOOL_NAMES.filter((t) => t !== "helix_edit"));
    expect(served.instructions).toMatch(/helix_show/u);
    expect(served.instructions).not.toMatch(/helix_edit/u);
    expect(served.instructions).toMatch(/Edit files with your normal tools/u);
    const sameEnv = await fake.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ thread: { id: "thr_x" } as never, environment: { id: "env_test", path: workspace } as never }),
    );
    // A test instance never serves a thread through its workspace.
    expect(names(sameEnv.tools)).toEqual([]);
    const other = await fake.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ thread: { id: "thr_y" } as never, environment: { id: "env_other", path: "/elsewhere" } as never }),
    );
    expect(names(other.tools)).toEqual([]);
  });
});

describe("capabilities", () => {
  it("offers only the tools the connected Helix supports, and more as it gains them", async () => {
    await teardown();
    dir = mkdtempSync(join(tmpdir().length > 60 ? "/tmp" : tmpdir(), "hxs-"));
    await setupWithCapabilities(["editor"]);
    const context = makePluginAgentConfigurationContext({ thread: { id: "thr_term" } as never });
    expect(names((await fake.harness.behavior.resolveAgentConfiguration(context)).tools)).toEqual(["helix_selection", "helix_show"]);
    await teardown();
    dir = mkdtempSync(join(tmpdir().length > 60 ? "/tmp" : tmpdir(), "hxs-"));
    await setupWithCapabilities(["editor", "reload", "locations", "diagnostics", "lsp"]);
    expect(names((await fake.harness.behavior.resolveAgentConfiguration(context)).tools)).toEqual(["helix_selection", "helix_show", "helix_tour", "helix_diagnostics", "helix_query"]);
  });
});

describe("test instances", () => {
  it("are never bound to a thread through their workspace", async () => {
    // Restart with no BB_THREAD_ID: the mock's workspace is env_test's path,
    // and env_test has thread thr_env, but a test instance stays unbound.
    reconcile.controller.abort();
    await reconcile.done.catch(() => {});
    await fake.harness.lifecycle.dispose();
    manager.dispose();
    await mock.stop();
    rmSync(dir, { recursive: true, force: true });
    await setup({});
    const out = await fake.harness.behavior.runCli(["list"]);
    expect(out.stdout).toMatch(/\(test\).*-> not bound/u);
    const tool = await fake.harness.behavior.callAgentTool("helix_selection", {}, { threadId: "thr_env" });
    expect(tool).toMatchObject({ isError: true });
    const bound = await fake.harness.behavior.runCli(["bind", "--instance", String(process.pid), "--thread", "thr_env"]);
    expect(bound.stdout).toMatch(/thr_env "Thread thr_env" \(explicit\)/u);
  });
});

describe("agent tools", () => {
  const ctx = { threadId: "thr_term" };

  it("shows a place and reveals the editor", async () => {
    const result = await fake.harness.behavior.callAgentTool("helix_show", { path: "util.go", line: 7, note: "the helper" }, ctx);
    expect(textOf(result)).toBe("The user is now at util.go:7 (pane 1).");
    expect(fake.harness.inspection.realtimeSignals.some((s) => s.channel === "reveal")).toBe(true);
    expect(mock.control({ cmd: "state" }).status).toEqual({ message: "the helper", severity: "info" });
  });

  it("reports a deferred jump while the user types", async () => {
    mock.control({ cmd: "busy" });
    const result = await fake.harness.behavior.callAgentTool("helix_show", { path: "util.go", line: 3 }, ctx);
    expect(textOf(result)).toMatch(/^Deferred: the user is busy.*:bb-go/u);
    expect(mock.control({ cmd: "state" }).pendingJump).toBe(true);
  });

  it("sets up a tour and lands on the first stop", async () => {
    const result = await fake.harness.behavior.callAgentTool(
      "helix_tour",
      { title: "Greeting flow", stops: [{ path: "main.go", line: 19, note: "starts here" }, { path: "main.go", line: 10, note: "constructor" }], now: true },
      ctx,
    );
    expect(textOf(result)).toMatch(/Tour "Greeting flow" with 2 stops. The user is at stop 1, main.go:19/u);
    expect(mock.control({ cmd: "state" }).lists).toEqual({ tour: 2 });
  });

  it("answers language-server queries as path:line with the preview", async () => {
    const def = await fake.harness.behavior.callAgentTool("helix_query", { kind: "definition", path: "util.go", line: 8, col: 16 }, ctx);
    expect(textOf(def)).toBe("main.go:10:6  func NewGreeter(name string) *Greeter {");
    const refs = await fake.harness.behavior.callAgentTool("helix_query", { kind: "references", path: "main.go", line: 10, col: 6 }, ctx);
    expect(textOf(refs).split("\n")).toHaveLength(3);
  });

  it("reads the selection, diagnostics and panes", async () => {
    mock.control({ cmd: "select", line: 14, col: 1, endLine: 16, endCol: 1 });
    expect(textOf(await fake.harness.behavior.callAgentTool("helix_selection", {}, ctx))).toMatch(/main.go:14-15[\s\S]*```go\nfunc \(g \*Greeter\) Greet\(\) string \{/u);
    mock.control({ cmd: "diagnostics", path: "main.go", errors: 1, warnings: 0 });
    expect(textOf(await fake.harness.behavior.callAgentTool("helix_diagnostics", {}, ctx))).toMatch(/^error   main.go:1:1/u);
    expect(textOf(await fake.harness.behavior.callAgentTool("helix_panes", {}, ctx))).toMatch(/\* pane 1  main.go/u);
  });

  it("edits a buffer as one step", async () => {
    const result = await fake.harness.behavior.callAgentTool("helix_edit", { path: "util.go", edits: [{ startLine: 4, startCol: 15, endLine: 4, endCol: 18, newText: `"?"` }] }, ctx);
    expect(textOf(result)).toMatch(/Applied 1 edit to util.go \(version 2, unsaved\)/u);
  });

  it("returns the command policy's refusal as the reason", async () => {
    const result = await fake.harness.behavior.callAgentTool("helix_command", { typed: "sh ls" }, ctx);
    expect(result).toMatchObject({ isError: true });
    expect(textOf(result)).toBe("unsupported: `sh` is refused by the command policy: it runs a shell command");
    expect(textOf(await fake.harness.behavior.callAgentTool("helix_command", { static: "goto_definition" }, ctx))).toMatch(/Status line: ran goto_definition/u);
  });

  it("refuses the :bb-* commands that speak in the user's name, and says what a command left open", async () => {
    const send = await fake.harness.behavior.callAgentTool("helix_command", { typed: "bb-send look" }, ctx);
    expect(textOf(send)).toBe("unsupported: `bb-send` is refused by the command policy: it sends a message to bb in the user's name");
    const left = await fake.harness.behavior.callAgentTool("helix_command", { keys: "<space>" }, ctx);
    expect(textOf(left)).toMatch(/left with the key sequence <space> half typed; the next request that moves the user waits/u);
    // A half-typed sequence makes the user busy, so the next jump waits.
    expect(textOf(await fake.harness.behavior.callAgentTool("helix_show", { path: "util.go", line: 3 }, ctx))).toMatch(/^Deferred/u);
    await fake.harness.behavior.callAgentTool("helix_command", { keys: "<esc>" }, ctx);
    expect(textOf(await fake.harness.behavior.callAgentTool("helix_command", { static: "replace" }, ctx))).toMatch(/waits for the next key/u);
  });

  it("defers closing the focused pane while the user is busy, but not another pane", async () => {
    await fake.harness.behavior.callAgentTool("helix_show", { path: "util.go", line: 3, split: "vertical", now: true }, ctx);
    const listed = textOf(await fake.harness.behavior.callAgentTool("helix_panes", {}, ctx));
    const focused = Number(/^\* pane (\d+)/mu.exec(listed)?.[1]);
    const other = Number(/^ {2}pane (\d+)/mu.exec(listed)?.[1]);
    mock.control({ cmd: "busy", what: "prompt" });
    expect(textOf(await fake.harness.behavior.callAgentTool("helix_panes", { action: "close", pane: focused }, ctx))).toMatch(/^Deferred.*:bb-go to close it/u);
    expect(textOf(await fake.harness.behavior.callAgentTool("helix_panes", { action: "close", pane: other }, ctx))).toMatch(new RegExp(`^\\* pane ${focused}  util.go`, "u"));
    mock.control({ cmd: "busy", what: "idle" });
  });

  it("numbers a new split after the panes already there", async () => {
    await teardown();
    await setup({ BB_THREAD_ID: "thr_term" });
    const shown = await fake.harness.behavior.callAgentTool("helix_show", { path: "util.go", line: 3, split: "vertical", now: true }, ctx);
    expect(textOf(shown)).toMatch(/\(pane 2\)/u);
    expect(textOf(await fake.harness.behavior.callAgentTool("helix_panes", {}, ctx))).toMatch(/layout: vertical\(1, 2\)/u);
  });

  it("counts the files a rename preview touches", async () => {
    const result = await fake.harness.behavior.callAgentTool("helix_query", { kind: "renamePreview", path: "main.go", line: 10, col: 6, newName: "MakeGreeter" }, ctx);
    expect(textOf(result)).toMatch(/^3 edits in 2 files \(not applied\)/u);
  });

  it("says when no editor serves the thread", async () => {
    const result = await fake.harness.behavior.callAgentTool("helix_selection", {}, { threadId: "thr_nobody" });
    expect(result).toMatchObject({ isError: true });
  });
});

describe("sends from Helix", () => {
  it("turns :bb-send into a draft for the thread's composer", async () => {
    mock.control({ cmd: "select", line: 10, col: 1, endLine: 12, endCol: 1 });
    mock.control({ cmd: "send", kind: "send", note: "is this safe?" });
    const drafts = await until(async () => {
      const { drafts: list } = (await fake.harness.behavior.callRpc("drafts", { threadId: "thr_term" })) as { drafts: { id: string; text: string }[] };
      return list.length > 0 && list;
    });
    expect(drafts[0]!.text).toBe("`main.go:10-11`\n```go\nfunc NewGreeter(name string) *Greeter {\n\treturn &Greeter{name: name}\n```\n\nis this safe?");
    expect(fake.harness.inspection.realtimeSignals.some((s) => s.channel === "draft")).toBe(true);
    await until(() => mock.control({ cmd: "state" }).status?.message === "Draft in Thread thr_term");
    await until(() => manager.pendingSends().length === 0);
    expect(sent).toEqual([]);
  });

  it("sends :bb-ask at once with the question first", async () => {
    mock.control({ cmd: "select", line: 19, col: 2 });
    mock.control({ cmd: "send", kind: "ask", note: "why bb?" });
    await until(() => sent.length === 1);
    expect(sent[0]).toEqual({ threadId: "thr_term", text: 'why bb?\n\n`main.go:19`\n```go\n\tg := NewGreeter("bb")\n```' });
  });

  it("keeps :bb-comment until :bb-comments-send sends them together", async () => {
    mock.control({ cmd: "select", line: 6, col: 1, endLine: 9, endCol: 1 });
    mock.control({ cmd: "send", kind: "comment", note: "rename to Welcomer" });
    await until(() => mock.control({ cmd: "state" }).status?.message === "Comment added: 1 pending (:bb-comments-send)");
    mock.control({ cmd: "select", line: 15, col: 1, endLine: 15, endCol: 10 });
    mock.control({ cmd: "send", kind: "comment", note: "use a constant" });
    await until(() => mock.control({ cmd: "state" }).status?.message === "Comment added: 2 pending (:bb-comments-send)");
    expect(sent).toEqual([]);
    mock.control({ cmd: "send", kind: "flush" });
    await until(() => sent.length === 1);
    expect(sent[0]!.text).toMatch(/^Review comments from Helix \(2\)[\s\S]*1\. `main.go:6-8`[\s\S]*rename to Welcomer[\s\S]*2\. `main.go:15`[\s\S]*use a constant/u);
    await until(() => mock.control({ cmd: "state" }).status?.message === "Sent 2 comments to Thread thr_term");
  });
});

describe("editor terminal", () => {
  it("starts one session per thread and reuses it", async () => {
    const created: unknown[] = [];
    const sessions: { id: string; title: string; status: string }[] = [];
    fake.harness.sdk.stub("terminals.list", async () => ({ sessions }) as never);
    fake.harness.sdk.stub("terminals.create", async (args: unknown) => {
      created.push(args);
      const session = { id: `term_${created.length}`, title: "Helix", status: "running" };
      sessions.push(session);
      return session as never;
    });
    const [a, b] = await Promise.all([
      fake.harness.behavior.callRpc("editorTerminal", { threadId: "thr_term" }),
      fake.harness.behavior.callRpc("editorTerminal", { threadId: "thr_term" }),
    ]);
    const again = await fake.harness.behavior.callRpc("editorTerminal", { threadId: "thr_term" });
    expect(created).toHaveLength(1);
    expect(a).toEqual({ terminalId: "term_1", created: true });
    expect(b).toEqual(a);
    expect(again).toEqual({ terminalId: "term_1", created: false });
    expect(created[0]).toMatchObject({ scope: { kind: "thread", threadId: "thr_term" }, title: "Helix", start: { mode: "command" } });
    // bb's terminals do not set BB_THREAD_ID; the session carries it so Helix records it.
    expect((created[0] as { start: { command: string } }).start.command).toMatch(/^BB_THREAD_ID=thr_term BB_ENVIRONMENT_ID=env_test BB_PROJECT_ID=\S+ HELIX_KITTY_KEYBOARD=enabled exec hxb$/u);
  });
});

describe("watching the agent write", () => {
  const fileChange = (path: string, status = "completed") => ({ type: "fileChange", status, changes: [{ path, kind: "update", diff: "" }] });

  it("reloads exactly the edited file with reveal and follow, as each edit lands (a Helix without watch)", async () => {
    await teardown();
    await setupWithCapabilities(ALL_CAPABILITIES.filter((c: string) => c !== "watch"));
    const scratch = join(workspace, "scratch-watch.go");
    writeFileSync(scratch, "package main\n");
    try {
      mock.control({ cmd: "select", path: "scratch-watch.go", line: 1 });
      let served = false;
      fake.harness.sdk.stub("threads.events.list", async () => [{ seq: 10 }] as never);
      fake.harness.sdk.stub("threads.events.wait", async ({ afterSeq }: { afterSeq?: string }) => {
        if (afterSeq === "10" && !served) {
          served = true;
          writeFileSync(scratch, "package main\n\nfunc added() {}\n");
          return { seq: 11, createdAt: Date.now(), data: { item: fileChange(scratch) } } as never;
        }
        await wait(50);
        return null as never;
      });
      await fake.harness.behavior.emitThreadEvent("thread.active", { thread: makeThreadResponse({ id: "thr_term", environmentId: "env_test" }) });
      const reveals = await until(() => {
        const r = mock.control({ cmd: "state" }).reveals as { paths: string[]; follow: boolean }[];
        return r.length > 0 && r;
      });
      expect(reveals[0]).toMatchObject({ paths: [scratch], follow: true });
      await fake.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_term", environmentId: "env_test" }), lastAssistantText: null });
    } finally {
      rmSync(scratch, { force: true });
    }
  });

  it("opens a file that is not open where the agent wrote, with the reveal", async () => {
    const scratch = join(workspace, "scratch-unopened.go");
    writeFileSync(scratch, "package main\n\nfunc old() {}\n");
    try {
      let served = false;
      fake.harness.sdk.stub("threads.events.list", async () => [{ seq: 20 }] as never);
      fake.harness.sdk.stub("threads.events.wait", async ({ afterSeq }: { afterSeq?: string }) => {
        if (afterSeq === "20" && !served) {
          served = true;
          writeFileSync(scratch, "package main\n\nfunc renamed() {}\n");
          const diff = `--- a${scratch}\n+++ b${scratch}\n-func old() {}\n+func renamed() {}\n`;
          return { seq: 21, createdAt: Date.now(), data: { item: { type: "fileChange", status: "completed", changes: [{ path: scratch, kind: "update", diff }] } } } as never;
        }
        await wait(50);
        return null as never;
      });
      await fake.harness.behavior.emitThreadEvent("thread.active", { thread: makeThreadResponse({ id: "thr_term", environmentId: "env_test" }) });
      const reveal = await until(() => (mock.control({ cmd: "state" }).reveals as { paths: string[]; ranges?: unknown; follow: boolean }[]).find((r) => r.paths[0] === scratch && r.ranges));
      expect(reveal).toMatchObject({ follow: true, ranges: [{ start: { line: 3, col: 1 }, end: { line: 4, col: 1 } }], removed: [{ line: 3, text: "func old() {}" }] });
      expect((mock.control({ cmd: "state" }).state as { focused: { path: string } }).focused.path).toBe(scratch);
      await fake.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_term", environmentId: "env_test" }), lastAssistantText: null });
    } finally {
      rmSync(scratch, { force: true });
    }
  });

  it("with watch, leaves reloading to Helix and follows its event/reloaded during a turn", async () => {
    const scratch = join(workspace, "scratch-watched.go");
    writeFileSync(scratch, "package main\n\nfunc a() {}\n");
    try {
      mock.control({ cmd: "select", path: "scratch-watched.go", line: 1 });
      mock.control({ cmd: "select", path: "main.go", line: 1 });
      let served = false;
      fake.harness.sdk.stub("threads.events.list", async () => [{ seq: 30 }] as never);
      fake.harness.sdk.stub("threads.events.wait", async ({ afterSeq }: { afterSeq?: string }) => {
        if (afterSeq === "30" && !served) {
          served = true;
          writeFileSync(scratch, "package main\n\nfunc a() {}\n\nfunc b() {}\n");
          return { seq: 31, createdAt: Date.now(), data: { item: { type: "fileChange", status: "completed", changes: [{ path: scratch, kind: "update", diff: "+func b() {}\n" }] } } } as never;
        }
        await wait(50);
        return null as never;
      });
      const thread = makeThreadResponse({ id: "thr_term", environmentId: "env_test" });
      await fake.harness.behavior.emitThreadEvent("thread.active", { thread });
      await until(() => served);
      await wait(300);
      // The plugin sent no reload: nothing animated, the buffer is as it was.
      expect(mock.control({ cmd: "state" }).reveals).toEqual([]);
      // Helix's own watcher reloads it and says what changed; the view follows
      // (once the user's last key is 1.5 s old: moving them sooner is deferred).
      await wait(1600);
      expect(mock.control({ cmd: "watch" }).reloaded).toEqual([scratch]);
      await until(() => (mock.control({ cmd: "state" }).state as { focused: { path: string } }).focused.path === scratch);
      expect((mock.control({ cmd: "state" }).state as { focused: { selections: { start: { line: number } }[] } }).focused.selections[0]!.start.line).toBe(5);
      await fake.harness.behavior.emitThreadEvent("thread.idle", { thread, lastAssistantText: null });
      // Outside a turn (the user's own edits elsewhere) the view stays.
      mock.control({ cmd: "select", path: "main.go", line: 1 });
      await wait(1600);
      writeFileSync(scratch, "package main\n\nfunc a() {}\n\nfunc c() {}\n");
      mock.control({ cmd: "watch" });
      await wait(400);
      expect((mock.control({ cmd: "state" }).state as { focused: { path: string } }).focused.path).toBe(join(workspace, "main.go"));
    } finally {
      rmSync(scratch, { force: true });
    }
  });

  it("lists at turn end only the hunks the turn added", async () => {
    const hunk = (path: string, line: number, old: string, now: string) => [`--- a/${path}`, `+++ b/${path}`, `@@ -${line},1 +${line},1 @@`, `-${old}`, `+${now}`].join("\n");
    const earlier = hunk("main.go", 3, "a", "b");
    let diff = earlier;
    await teardown();
    await setup({ BB_THREAD_ID: "thr_term" }, {
      plugins: {
        list: async () => [],
        callRpc: async ({ method }: { method: string }) => {
          if (method === "workspaceStatus") return { outcome: "available", workspace: { checkout: { headSha: "abc" } } };
          if (method === "diff") return { outcome: "available", diff: { diff, truncated: false } };
          throw new Error(`unexpected ${method}`);
        },
      },
    });
    const thread = makeThreadResponse({ id: "thr_term", environmentId: "env_test" });
    const lists = () => mock.control({ cmd: "state" }).lists as Record<string, number>;
    fake.harness.sdk.stub("threads.events.list", async () => [] as never);
    fake.harness.sdk.stub("threads.events.wait", async () => (await wait(50), null) as never);
    // The turn adds one hunk to a diff that already had one.
    await fake.harness.behavior.emitThreadEvent("thread.active", { thread });
    await wait(100);
    diff = `${earlier}\n${hunk("util.go", 7, "x", "y")}`;
    await fake.harness.behavior.emitThreadEvent("thread.idle", { thread, lastAssistantText: null });
    await until(() => lists().changes === 1);
    // A turn that changes nothing leaves that list alone.
    await fake.harness.behavior.emitThreadEvent("thread.active", { thread });
    await wait(100);
    await fake.harness.behavior.emitThreadEvent("thread.idle", { thread, lastAssistantText: null });
    await wait(300);
    expect(lists().changes).toBe(1);
  });

  it("finds where a diff without line numbers landed", () => {
    const text = "a\nb\nnew one\nnew two\nc\n";
    expect(revealOf("--- a/x\n+++ b/x\n-old\n+new one\n+new two\n", text)).toEqual({ ranges: [{ start: { line: 3, col: 1 }, end: { line: 5, col: 1 } }], removed: [{ line: 3, text: "old" }] });
    expect(revealOf("--- /dev/null\n+++ b/x\n+a\n+b\n", text)?.ranges[0]).toEqual({ start: { line: 1, col: 1 }, end: { line: 7, col: 1 } });
    expect(revealOf("--- a/x\n+++ b/x\n-gone\n", text)).toBeNull();
    expect(revealOf("--- a/x\n+++ b/x\n+not there\n", text)).toBeNull();
  });

  it("reloads without the reveal when Helix does not offer it", async () => {
    await teardown();
    dir = mkdtempSync(join(tmpdir().length > 60 ? "/tmp" : tmpdir(), "hxs-"));
    await setupWithCapabilities(["editor", "reload"]);
    const scratch = join(workspace, "scratch-watch2.go");
    writeFileSync(scratch, "package main\n");
    try {
      mock.control({ cmd: "select", path: "scratch-watch2.go", line: 1 });
      let served = false;
      fake.harness.sdk.stub("threads.events.list", async () => [] as never);
      fake.harness.sdk.stub("threads.events.wait", async () => {
        if (!served) {
          served = true;
          writeFileSync(scratch, "package main\n// edited\n");
          return { seq: 1, createdAt: Date.now(), data: { item: fileChange(scratch) } } as never;
        }
        await wait(50);
        return null as never;
      });
      await fake.harness.behavior.emitThreadEvent("thread.active", { thread: makeThreadResponse({ id: "thr_term", environmentId: "env_test" }) });
      await until(() => (mock.control({ cmd: "state" }).state as { documents: { path: string; version: number }[] }).documents.find((d) => d.path === scratch && d.version === 2));
      expect(mock.control({ cmd: "state" }).reveals).toEqual([]);
      await fake.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_term", environmentId: "env_test" }), lastAssistantText: null });
    } finally {
      rmSync(scratch, { force: true });
    }
  });

  it("names the files a completed edit wrote, and nothing else", () => {
    expect(editedPaths(fileChange("/w/a.go"), "/w")).toEqual(["/w/a.go"]);
    expect(editedPaths(fileChange("b.go"), "/w")).toEqual(["/w/b.go"]);
    // macOS: the agent reports the resolved path, Helix and bb the environment's.
    expect(editedPaths(fileChange("/private/tmp/w/a.go"), "/tmp/w")).toEqual(["/tmp/w/a.go"]);
    expect(editedPaths(fileChange("/tmp/w/a.go"), "/private/tmp/w")).toEqual(["/private/tmp/w/a.go"]);
    expect(editedPaths(fileChange("/w/a.go", "pending"), "/w")).toBeNull();
    expect(editedPaths({ type: "commandExecution", status: "completed" }, "/w")).toBeNull();
    expect(editedPaths({ type: "fileChange", status: "completed", changes: [{ path: "/w/gone.go", kind: "delete" }] }, "/w")).toBeNull();
  });
});

describe("the file tree", () => {
  it("layers its two settings on the user's yazi.toml without overriding theirs", () => {
    const fresh = treeYaziToml(null);
    expect(fresh).toMatch(/\[manager\]\nratio = \[0, 1, 0\]/u);
    expect(fresh).toMatch(/\[opener\]\nedit = \[\{ run = '"\$HELIX_BRIDGE_OPEN" "\$@"', desc = "Open in Helix", orphan = true, for = "unix" \}\]/u);
    const theirs = treeYaziToml('[manager]\nshow_hidden = true\n\n[opener]\nedit = [{ run = "nvim $@", block = true }]\n');
    expect(theirs).toMatch(/\[manager\]\nratio = \[0, 1, 0\]\nshow_hidden = true/u);
    expect(theirs).toMatch(/edit = \[\{ run = "nvim \$@", block = true \}\]/u);
    expect(theirs).not.toMatch(/Open in Helix/u);
    expect(theirs.match(/^\[manager\]/gmu)).toHaveLength(1);
    expect(treeYaziToml("[manager]\nratio = [1, 4, 3]\n")).not.toMatch(/ratio = \[0, 1, 0\]/u);
  });

  it("opens the chosen file straight over Helix's socket, and falls back to bb hx tree-open", async () => {
    await teardown();
    await setup({ BB_THREAD_ID: "thr_term" });
    const script = join(dir, "helix-open");
    writeFileSync(script, OPENER_SCRIPT);
    chmodSync(script, 0o755);
    execFileSync("sh", ["-n", script]);
    const log = join(dir, "bb-calls.log");
    const fakeBb = join(dir, "fake-bb");
    writeFileSync(fakeBb, `#!/bin/sh\necho "$@" >> ${log}\n`);
    chmodSync(fakeBb, 0o755);
    const env = { ...process.env, HELIX_BRIDGE_DIR: dir, BB_CLI: fakeBb };
    // The mock serves thr_term: the file opens without bb.
    const started = Date.now();
    // Async: the mock answers from this process, which must not block.
    await run(script, [join(workspace, "util.go")], { env: { ...env, BB_THREAD_ID: "thr_term" } });
    const elapsed = Date.now() - started;
    expect((mock.control({ cmd: "state" }).state as { focused: { path: string } }).focused.path).toBe(join(workspace, "util.go"));
    expect(() => readFileSync(log, "utf8")).toThrow();
    // nc waits a second for more before it exits; the open itself is immediate.
    expect(elapsed).toBeLessThan(2500);
    // No Helix for that thread: bb hx tree-open gets the files.
    await run(script, [join(workspace, "main.go")], { env: { ...env, BB_THREAD_ID: "thr_other" } });
    expect(readFileSync(log, "utf8").trim()).toBe(`hx tree-open ${join(workspace, "main.go")}`);
  });

  it("takes :bb-files for a Helix the plugin started in a bb terminal, and tells the editor page", async () => {
    await teardown();
    await setup({ BB_THREAD_ID: "thr_term", BB_TERMINAL_SESSION_ID: "term_helix1" });
    await until(() => (mock.control({ cmd: "state" }).subscriptions as string[][]).some((s) => s.includes("files")));
    expect(mock.control({ cmd: "files" })).toMatchObject({ emitted: true });
    const signal = await until(() => fake.harness.inspection.realtimeSignals.find((s) => s.channel === "files"));
    expect(signal.payload).toMatchObject({ threadId: "thr_term", path: join(workspace, "main.go") });
  });

  it("leaves :bb-files to Helix in the user's own terminal, and to an instance bound only by thread", async () => {
    for (const env of [{ BB_TERMINAL_SESSION_ID: "term_users1" }, { BB_THREAD_ID: "thr_term" }] as Record<string, string>[]) {
      await teardown();
      await setup(env);
      await until(() => (mock.control({ cmd: "state" }).subscriptions as string[][]).some((s) => s.includes("send")));
      await wait(100);
      expect((mock.control({ cmd: "state" }).subscriptions as string[][]).some((s) => s.includes("files"))).toBe(false);
      // Nobody subscribed: Helix runs its own file manager, full screen.
      expect(mock.control({ cmd: "files" })).toMatchObject({ emitted: false, ranFileManager: true });
    }
  });

  it("gives each thread its own stable yazi client id", () => {
    expect(treeClientId("thr_a")).toBe(treeClientId("thr_a"));
    expect(treeClientId("thr_a")).not.toBe(treeClientId("thr_b"));
    expect(treeClientId("thr_a")).toMatch(/^\d{1,15}$/u);
  });

  it("opens what the tree chose in the Helix serving the thread, and tells the app", async () => {
    const result = await fake.harness.behavior.runCli(["tree-open", join(workspace, "util.go")], { threadId: "thr_term" });
    expect(result.exitCode).toBe(0);
    await until(() => (mock.control({ cmd: "state" }).state as { focused: { path: string } }).focused.path === join(workspace, "util.go"));
    expect(fake.harness.inspection.realtimeSignals.some((s) => s.channel === "tree-open" && (s.payload as { threadId: string }).threadId === "thr_term")).toBe(true);
  });
});

describe("review comments in the code", () => {
  const comment = (over: Partial<ReviewComment>): ReviewComment =>
    ({ id: "rc_1", path: "main.go", startLine: 10, endLine: 12, body: "why?", severity: "issue", state: "open", resolvedBy: null, acknowledgedAt: null, replies: [], ...over }) as ReviewComment;

  it("shows a comment with its sign and replies, and settles with Review Editor's states", () => {
    expect(commentItems(comment({}))).toEqual([{ line: 10, endLine: 12, text: "why?", kind: "comment", severity: "warning", sign: "●" }]);
    const replied = commentItems(comment({ state: "sent", replies: [{ author: "agent", body: "fixed it" }] as never }));
    expect(replied[1]).toEqual({ line: 12, text: "Agent: fixed it", kind: "reply" });
    expect(commentItems(comment({ state: "resolved", resolvedBy: "user" }))).toEqual([]);
    expect(commentItems(comment({ state: "resolved", resolvedBy: "agent", acknowledgedAt: null })).at(-1)).toMatchObject({ kind: "note" });
    expect(commentItems(comment({ state: "resolved", resolvedBy: "agent", acknowledgedAt: 1 }))).toEqual([]);
  });

  it("sets annotations at once for a Review Editor comment, updates them when Review Editor says so, and clears them", async () => {
    let comments: ReviewComment[] = [comment({})];
    const reads: unknown[] = [];
    await teardown();
    await setup({ BB_THREAD_ID: "thr_term" }, {
      plugins: {
        list: async () => [{ id: "review-editor", status: "running" }],
        callRpc: async ({ method, input }: { method: string; input: unknown }) => {
          reads.push(input);
          if (method === "listComments") return { comments };
          throw new Error(`unexpected ${method}`);
        },
      },
    });
    // The background service starts the annotator (and its 30 s fallback).
    fake.harness.sdk.stub("subscribe", () => () => {});
    const service = fake.harness.behavior.runService("environment-changes");
    const file = join(workspace, "main.go");
    const annotations = () => (mock.control({ cmd: "state" }).annotations as Record<string, { text: string; kind: string }[]>)[file];
    // Connecting sends everything.
    await until(() => annotations()?.length === 1, 8000);
    expect(annotations()[0]).toMatchObject({ text: "why?", kind: "comment", sign: "●", line: 10, endLine: 12 });
    // Review Editor's call after a write re-reads that one file, well before any poll.
    const changed = () => fake.harness.behavior.callRpc("commentsChanged", { environmentId: "env_test", path: "main.go" });
    comments = [comment({ state: "sent", replies: [{ author: "agent", body: "on it" }] as never })];
    expect(await changed()).toEqual({ accepted: true });
    await until(() => annotations()?.length === 2, 2000);
    expect(annotations()[1]).toMatchObject({ text: "Agent: on it", kind: "reply" });
    expect(reads.at(-1)).toMatchObject({ environmentId: "env_test", path: "main.go" });
    comments = [comment({ state: "resolved", resolvedBy: "user" })];
    await changed();
    await until(() => annotations() === undefined, 2000);
    comments = [comment({})];
    await changed();
    await until(() => annotations()?.length === 1, 2000);
    // A path outside the environment is ignored.
    const before = reads.length;
    await fake.harness.behavior.callRpc("commentsChanged", { environmentId: "env_test", path: "../outside.go" });
    await wait(100);
    expect(reads.length).toBe(before);
    service.controller.abort();
    await service.done.catch(() => {});
  });
});

describe("comments Review Editor refuses", () => {
  it("keeps the comment here and says why", async () => {
    await teardown();
    await setup({ BB_THREAD_ID: "thr_term" }, {
      plugins: {
        list: async () => [{ id: "review-editor", status: "running" }],
        callRpc: async ({ method }: { method: string }) => {
          if (method === "createComment") throw new Error("HTTP 422: Lines 30-30 are outside the file (it has 21 lines)");
          if (method === "listComments") return { comments: [] };
          throw new Error(`unexpected ${method}`);
        },
      },
    });
    mock.control({ cmd: "select", line: 3, col: 1, endLine: 4, endCol: 1 });
    mock.control({ cmd: "send", kind: "comment", note: "on new lines" });
    await until(() => String(mock.control({ cmd: "state" }).status?.message ?? "").startsWith("Comment kept in Helix Bridge (Review Editor: Lines 30-30 are outside the file"));
    mock.control({ cmd: "send", kind: "flush" });
    await until(() => sent.length === 1);
    expect(sent[0]!.text).toMatch(/^Review comments from Helix \(1\)[\s\S]*on new lines/u);
  });
});

describe("helpers", () => {
  it("parses locations", () => {
    expect(parseLocation("a/b.go")).toEqual({ path: "a/b.go" });
    expect(parseLocation("a/b.go:12")).toEqual({ path: "a/b.go", line: 12 });
    expect(parseLocation("a/b.go:12:4")).toEqual({ path: "a/b.go", line: 12, col: 4 });
    expect(parseLocation("a/b.go:12-20")).toEqual({ path: "a/b.go", line: 12, endLine: 20 });
  });

  it("turns a unified diff into change locations", () => {
    const diff = [
      "diff --git a/x.go b/x.go",
      "--- a/x.go",
      "+++ b/x.go",
      "@@ -3,2 +3,4 @@ func a()",
      "@@ -40 +42,0 @@",
      "diff --git a/gone.go b/gone.go",
      "--- a/gone.go",
      "+++ /dev/null",
      "@@ -1,3 +0,0 @@",
    ].join("\n");
    expect(hunksFromDiff(diff, "/repo/")).toEqual([
      { path: "/repo/x.go", line: 3, endLine: 6, label: "+4 -2" },
      { path: "/repo/x.go", line: 42, label: "+0 -1" },
    ]);
    // With git's context lines, the span and the label cover the change only.
    const context = ["--- a/main.go", "+++ b/main.go", "@@ -2,7 +2,7 @@", " ", " import \"fmt\"", " ", "-// old", "+// new", " type Greeter struct {", " \tname string", " }"].join("\n");
    expect(hunksFromDiff(context, "/repo")).toEqual([{ path: "/repo/main.go", line: 5, endLine: 5, label: "+1 -1" }]);
  });

  it("formats a send as path and lines, fenced code, unsaved note", () => {
    const block = selectionBlock(
      { kind: "send", note: "", path: "/w/a.ts", docId: 1, languageId: "typescript", version: 2, modified: true, truncated: false, sendNow: false, ranges: [{ start: { line: 3, col: 1 }, end: { line: 5, col: 1 }, text: "const a = 1;\nconst b = `x`;" }] },
      ["/w"],
    );
    expect(block).toBe("`a.ts:3-4` (unsaved changes in the editor; the file on disk differs)\n```typescript\nconst a = 1;\nconst b = `x`;\n```");
  });
});
