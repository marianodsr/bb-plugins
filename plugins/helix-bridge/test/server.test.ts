// The server end to end in-process: bb's fake plugin host, its host-RPC
// driver wired to a real InstanceManager, and the mock bridge behind it.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
import { editedPaths, placesOf, revealOf } from "../server/watch";
import { revParse as gitRevParse, subject as gitSubject } from "../host/git";
import { applyOp, checkPaths, listDirs } from "../host/files";
import type { FileOp } from "../app/files/types";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
import { chmodSync, readFileSync } from "node:fs";
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
/** Every threads.send in full (mode and mentions too). */
let sentArgs: { threadId: string; mode?: string; input: { type: string; text: string; mentions?: unknown[] }[] }[];
let reconcile: { controller: AbortController; done: Promise<void> };
/** thr_files's workspace (env_files): a temporary folder the file tree may change. */
let filesRoot: string;

const textOf = (result: unknown) => ((result as { content: { text: string }[] }).content ?? []).map((c) => c.text).join("\n");

async function teardown() {
  reconcile.controller.abort();
  await reconcile.done.catch(() => {});
  await fake.harness.lifecycle.dispose();
  manager.dispose();
  await mock.stop();
  rmSync(dir, { recursive: true, force: true });
  rmSync(filesRoot, { recursive: true, force: true });
}

let capabilities: string[] | null = null;
/** Git reads made through the fake host or bb's Git plugin. */
let gitReads = 0;
/** Settings for the next setup() (the agent tools are off by default). */
let extraSettings: Record<string, string | number | boolean> = {};
const ALL_TOOLS_ON = { agentTools: "show, tour, selection, query, diagnostics, edit, panes, command, review" };

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
  filesRoot = realpathSync(mkdtempSync(join(tmpdir(), "hxs-files-")));
  mock = await startMockBridge({ dir, workspace, open: ["main.go"], pid: process.pid, env, ...(capabilities ? { capabilities } : {}) });
  sent = [];
  sentArgs = [];
  fake = createFakePluginHost({
    pluginId: "helix-bridge",
    agentSkillIds: ["helix-bridge"],
    settings: { bridgeDir: dir, ...extraSettings },
    sdk: {
      hosts: { list: async () => [makeHostResponse({ id: HOST, status: "connected" })] },
      environments: {
        list: async () => [{ id: "env_test", hostId: HOST, path: workspace }] as never,
        get: async ({ environmentId }: { environmentId: string }) => ({ id: environmentId, hostId: HOST, path: environmentId === "env_test" ? workspace : environmentId === "env_files" ? filesRoot : "/elsewhere" }) as never,
      },
      threads: {
        // thr_nobody lives in another environment; every other thread in env_test.
        get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, environmentId: threadId === "thr_nobody" ? "env_other" : threadId === "thr_files" ? "env_files" : "env_test", title: `Thread ${threadId}` }),
        list: async () => [makeThreadResponse({ id: "thr_env", environmentId: "env_test" })],
        send: async (args: { threadId: string; input: { text: string }[] }) => {
          sent.push({ threadId: args.threadId, text: args.input[0]!.text });
          sentArgs.push(args as never);
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
        case "gitRead": {
          // The host's read-only git, run here.
          const cwd = String(args.cwd);
          gitReads += 1;
          const rev = args.rev as string | undefined;
          if (args.op === "revParse") return { sha: rev ? await gitRevParse(cwd, rev) : null, error: null };
          if (args.op === "subject") return { subject: rev ? await gitSubject(cwd, rev) : "", error: null };
          throw new Error(`unexpected gitRead ${String(args.op)}`);
        }
        case "filesList":
          return listDirs(String(args.root), args.dirs as string[]);
        case "filesCheck":
          return checkPaths(String(args.root), args.paths as string[], args.intent as "read" | "write");
        case "filesOp":
          // The trash is the test's own folder.
          return applyOp(String(args.root), args.op as FileOp, { trashDir: join(filesRoot, "..") });
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

  it("offers no tool and no instruction by default: only the skill", async () => {
    const served = await fake.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ thread: { id: "thr_term" } as never, environment: { id: "env_other", path: "/elsewhere" } as never }),
    );
    expect(names(served.tools ?? [])).toEqual([]);
    expect(served.instructions ?? null).toBeNull();
    expect(served.skills).toEqual(["helix-bridge"]);
  });

  it("offers the switched-on tools only to a thread a connected Helix serves", async () => {
    await teardown();
    extraSettings = { agentTools: "show,tour,selection,query,diagnostics" };
    try {
      await setup();
    } finally {
      extraSettings = {};
    }
    const served = await fake.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ thread: { id: "thr_term" } as never, environment: { id: "env_other", path: "/elsewhere" } as never }),
    );
    expect(names(served.tools)).toEqual(["helix_selection", "helix_show", "helix_tour", "helix_diagnostics", "helix_query"]);
    expect(served.instructions).not.toMatch(/helix_command/u);
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
    extraSettings = ALL_TOOLS_ON;
    await setupWithCapabilities(["editor"]);
    const context = makePluginAgentConfigurationContext({ thread: { id: "thr_term" } as never });
    expect(names((await fake.harness.behavior.resolveAgentConfiguration(context)).tools)).toEqual(["helix_selection", "helix_show"]);
    await teardown();
    dir = mkdtempSync(join(tmpdir().length > 60 ? "/tmp" : tmpdir(), "hxs-"));
    await setupWithCapabilities(["editor", "reload", "locations", "diagnostics", "lsp"]);
    extraSettings = {};
    expect(names((await fake.harness.behavior.resolveAgentConfiguration(context)).tools)).toEqual(["helix_selection", "helix_show", "helix_tour", "helix_diagnostics", "helix_query"]);
  });
});

describe("reviews in the editor", () => {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const parent = execFileSync("git", ["rev-parse", "HEAD^"], { encoding: "utf8" }).trim();
  const base = "a".repeat(40);
  let files: { path: string; previousPath: string | null; changeKind: string; additions: number; deletions: number; revision?: string }[] = [];
  let viewedMarks: { path: string; revision: string }[] = [];
  const gitCalls: { method: string; input: unknown }[] = [];
  const hunkDiff = (path: string) => [`--- a/${path}`, `+++ b/${path}`, "@@ -3,1 +3,1 @@", "-old", "+new"].join("\n");
  const reviewSetup = async (extra: Record<string, unknown> = {}) => {
    await teardown();
    await setup({ BB_THREAD_ID: "thr_term" }, {
      plugins: {
        list: async () => [{ id: "review-editor", status: "running" }],
        callRpc: async ({ pluginId, method, input }: { pluginId: string; method: string; input: { target?: { type: string }; keys?: string[]; path?: string; revision?: string } }) => {
          if (pluginId === "bb--git") {
            gitReads += 1;
            gitCalls.push({ method, input });
          }
          if (pluginId === "bb--git" && method === "viewed") return { files: viewedMarks };
          if (pluginId === "bb--git" && (method === "markViewed" || method === "clearViewed")) return { ok: true };
          if (pluginId === "bb--git" && method === "patches") return Object.fromEntries((input.keys ?? []).map((k) => [k, { outcome: "available", patch: { path: "main.go", patch: hunkDiff("main.go"), truncated: false } }]));
          if (pluginId === "bb--git" && method === "workspaceStatus") return { outcome: "available", workspace: { branch: { currentBranch: "feature", defaultBranch: "main" }, checkout: { headSha: head } } };
          if (pluginId === "bb--git" && method === "files") return { outcome: "available", files, mergeBaseRef: input.target?.type === "all" ? base : null, truncated: false, shortstat: "", initialPatches: [] };
          if (pluginId === "bb--git" && method === "diff") return { outcome: "available", diff: { diff: files.map((f) => hunkDiff(f.path)).join("\n"), truncated: false } };
          if (pluginId === "bb--github-pr-status") return { env_test: { outcome: "absent" } };
          if (pluginId === "review-editor" && method === "listComments") return { comments: [{ id: "rc_1", threadId: "thr_term", state: "open", path: "main.go", startLine: 10, endLine: 10, body: "why?", resolvedBy: null, acknowledgedAt: null, replies: [], severity: "note" }] };
          if (pluginId === "review-editor" && method === "compilePrompt") return { prompt: "COMPILED PROMPT" };
          if (pluginId === "review-editor" && method === "markSent") return { comments: [] };
          throw new Error(`unexpected ${pluginId} ${method}`);
        },
        ...extra,
      },
    } as never);
    await until(() => (mock.control({ cmd: "state" }).subscriptions as string[][]).some((x) => x.includes("review")));
  };
  const review = () => mock.control({ cmd: "state" }).review as { id: string; title: string; base: string | null; files: { path: string; status: string }[] } | null;

  it("starts a review from :bb-review, keeps it current, and ends it with off", async () => {
    files = [{ path: "main.go", previousPath: null, changeKind: "modified", additions: 2, deletions: 1 }];
    await reviewSetup();
    mock.control({ cmd: "review", target: "branch" });
    await until(() => review()?.base === base);
    expect(review()).toMatchObject({ title: "feature against main", files: [{ path: join(workspace, "main.go"), status: "modified" }] });
    expect(mock.control({ cmd: "state" }).lists).toMatchObject({ review: 1 });
    await until(() => /Reviewing feature against main: 1 file, \+2 -1/u.test(String((mock.control({ cmd: "state" }).status as { message?: string } | null)?.message ?? "")));
    // A file is added and saved in Helix: the same review grows, without a
    // new id. No timer: only signals (a save here) refresh it.
    const id = review()!.id;
    files = [...files, { path: "util.go", previousPath: null, changeKind: "added", additions: 9, deletions: 0 }];
    await wait(1500);
    expect(review()!.files).toHaveLength(1);
    mock.control({ cmd: "save", path: "main.go" });
    await until(() => review()?.files.length === 2, 4000);
    expect(review()!.id).toBe(id);
    expect(mock.control({ cmd: "state" }).lists).toMatchObject({ review: 2 });
    // The page reads it.
    expect(await fake.harness.behavior.callRpc("reviewState", { threadId: "thr_term" })).toMatchObject({ capable: true, review: { target: "branch", files: 2 }, openComments: 1 });
    mock.control({ cmd: "review", target: "off" });
    await until(() => review() === null);
  });

  it("compares uncommitted changes with HEAD and a commit with its parent", async () => {
    files = [{ path: "util.go", previousPath: null, changeKind: "modified", additions: 1, deletions: 1 }];
    await reviewSetup();
    mock.control({ cmd: "review", target: "uncommitted" });
    await until(() => review()?.title === "Uncommitted changes");
    expect(review()!.base).toBeNull();
    const out = await fake.harness.behavior.runCli(["review", "commit", head.slice(0, 10)], { threadId: "thr_term" });
    expect(out.stdout).toMatch(new RegExp(`^Reviewing Commit ${head.slice(0, 7)}`, "u"));
    expect(review()!.base).toBe(parent);
  });

  it("reads no git when an agent turn starts or ends", async () => {
    await reviewSetup();
    const thread = makeThreadResponse({ id: "thr_term", environmentId: "env_test" });
    fake.harness.sdk.stub("threads.events.list", async () => [] as never);
    fake.harness.sdk.stub("threads.events.wait", async () => (await wait(50), null) as never);
    gitReads = 0;
    await fake.harness.behavior.emitThreadEvent("thread.active", { thread });
    await wait(300);
    await fake.harness.behavior.emitThreadEvent("thread.idle", { thread, lastAssistantText: null });
    await wait(300);
    expect(gitReads).toBe(0);
  });

  it("says why a review cannot start", async () => {
    await reviewSetup();
    expect((await fake.harness.behavior.runCli(["review", "pr"], { threadId: "thr_term" })).stderr).toMatch(/this branch has no pull request/u);
    expect((await fake.harness.behavior.runCli(["review", "turn"], { threadId: "thr_term" })).stderr).toMatch(/unknown review target "turn"/u);
    expect((await fake.harness.behavior.runCli(["review", "sideways"], { threadId: "thr_term" })).stderr).toMatch(/unknown review target "sideways"/u);
  });

  it("opens a file from Review Editor's list in the thread's own Helix, with a review active", async () => {
    files = [{ path: "util.go", previousPath: null, changeKind: "modified", additions: 1, deletions: 1 }];
    await reviewSetup();
    expect(await fake.harness.behavior.callRpc("environmentStatus", { environmentId: "env_test", threadId: "thr_nobody" })).toEqual({ serves: false, review: false });
    expect(await fake.harness.behavior.callRpc("environmentStatus", { environmentId: "env_test", threadId: "thr_term" })).toEqual({ serves: true, review: true });
    const opened = await fake.harness.behavior.callRpc("openInReview", { environmentId: "env_test", threadId: "thr_term", path: "util.go" });
    expect(opened).toMatchObject({ opened: true, message: expect.stringMatching(/^Reviewing Uncommitted changes/u) });
    expect(review()?.title).toBe("Uncommitted changes");
    expect((mock.control({ cmd: "state" }).state as { focused: { path: string } }).focused.path).toBe(join(workspace, "util.go"));
    // At the file's first change (the diff's hunk starts at line 3).
    expect((mock.control({ cmd: "state" }).state as { focused: { selections: { start: { line: number } }[] } }).focused.selections[0]!.start.line).toBe(3);
  });

  it("gives the rail the review's files with bb's viewed marks, and marks them", async () => {
    files = [
      { path: "main.go", previousPath: null, changeKind: "modified", additions: 2, deletions: 1, revision: "100644:a:100644:b" },
      { path: "util.go", previousPath: null, changeKind: "added", additions: 4, deletions: 0, revision: "000000:0:100644:c" },
    ];
    // util.go was viewed at an older revision: it counts as not viewed.
    viewedMarks = [
      { path: "main.go", revision: "100644:a:100644:b" },
      { path: "util.go", revision: "000000:0:100644:old" },
    ];
    await reviewSetup();
    expect(await fake.harness.behavior.callRpc("changes", { threadId: "thr_term" })).toMatchObject({ capable: true, connected: true, review: null });
    // The first scope: the branch has commits of its own.
    expect(await fake.harness.behavior.callRpc("startReview", { threadId: "thr_term", target: "auto" })).toMatchObject({ message: expect.stringMatching(/^Reviewing feature against main/u) });
    const changes = (await fake.harness.behavior.callRpc("changes", { threadId: "thr_term" })) as { review: { scope: string; files: { path: string; viewed: boolean; revision: string | null }[] } };
    expect(changes.review.scope).toBe("branch");
    expect(changes.review.files.map((f) => [f.path, f.viewed])).toEqual([
      ["main.go", true],
      ["util.go", false],
    ]);
    gitCalls.length = 0;
    await fake.harness.behavior.callRpc("setViewed", { threadId: "thr_term", path: "util.go", viewed: true });
    expect(gitCalls).toEqual([{ method: "markViewed", input: { environmentId: "env_test", target: { type: "all", mergeBaseBranch: "main" }, path: "util.go", revision: "000000:0:100644:c" } }]);
    // bb's Git plugin keys a patch by environment, target, whitespace, path and revision.
    gitCalls.length = 0;
    const patch = (await fake.harness.behavior.callRpc("filePatch", { threadId: "thr_term", path: "main.go", revision: "100644:a:100644:b" })) as { patch: string | null };
    expect(patch.patch).toContain("@@ -3,1 +3,1 @@");
    expect((gitCalls[0]?.input as { keys: string[] }).keys).toEqual([JSON.stringify(["env_test", { type: "all", mergeBaseBranch: "main" }, false, "main.go", "100644:a:100644:b"])]);
    viewedMarks = [];
  });

  it("opens a reviewed file at a line or its first change, and switches the inline diff", async () => {
    files = [{ path: "util.go", previousPath: null, changeKind: "modified", additions: 1, deletions: 1, revision: "r1" }];
    await reviewSetup();
    await fake.harness.behavior.callRpc("startReview", { threadId: "thr_term", target: "uncommitted" });
    await fake.harness.behavior.callRpc("openChange", { threadId: "thr_term", path: "util.go" });
    const line = () => (mock.control({ cmd: "state" }).state as { focused: { selections: { start: { line: number } }[] } }).focused.selections[0]!.start.line;
    await until(() => line() === 3);
    await fake.harness.behavior.callRpc("openChange", { threadId: "thr_term", path: "util.go", line: 2 });
    await until(() => line() === 2);
    await fake.harness.behavior.callRpc("setInline", { threadId: "thr_term", inline: false });
    expect((mock.control({ cmd: "state" }).review as { inline?: boolean }).inline).toBe(false);
  });

  it("names the review when its comments go to the agent", async () => {
    files = [{ path: "main.go", previousPath: null, changeKind: "modified", additions: 2, deletions: 1 }];
    await reviewSetup();
    mock.control({ cmd: "review", target: "branch" });
    await until(() => review()?.base === base);
    sent = [];
    expect(await fake.harness.behavior.callRpc("sendReviewComments", { threadId: "thr_term" })).toMatchObject({ message: expect.stringMatching(/^Sent to /u) });
    expect(sent[0]?.text).toBe("Review of feature against main.\n\nCOMPILED PROMPT");
  });
});

describe("the CLI an agent uses to show places", () => {
  it("opens a place in the calling thread's Helix and says where the user is", async () => {
    await wait(1600); // the mock's user is idle
    const out = await fake.harness.behavior.runCli(["open", "util.go:3-5", "--note", "the helper"], { threadId: "thr_term" });
    expect(out.stdout).toBe("Opened util.go:3-5.");
    expect((mock.control({ cmd: "state" }).state as { focused: { path: string } }).focused.path).toBe(join(workspace, "util.go"));
    mock.control({ cmd: "busy" });
    const deferred = await fake.harness.behavior.runCli(["open", "main.go:10"], { threadId: "thr_term" });
    expect(deferred.stdout).toMatch(/^Deferred: the user is busy.*bb wants to show main.go:10 \(:bb-go\)/u);
  });

  it("runs a tour from arguments or from --stops, and jumps to the first stop", async () => {
    await wait(1600);
    const out = await fake.harness.behavior.runCli(["tour", "--title", "Greeting", "main.go:10 the constructor", "main.go:14-16 the greeting"], { threadId: "thr_term" });
    expect(out.stdout).toBe("Tour with 2 stops; the user is at stop 1, main.go:10. They continue with :bb-next.");
    expect(mock.control({ cmd: "state" }).lists).toMatchObject({ tour: 2 });
    const fromStdin = await fake.harness.behavior.runCli(["tour", "--stops", "util.go:3 one\nutil.go:7 two\nmain.go:19 three"], { threadId: "thr_term" });
    expect(fromStdin.stdout).toMatch(/^Tour with 3 stops/u);
    const bad = await fake.harness.behavior.runCli(["tour", "main.go no line here"], { threadId: "thr_term" });
    expect(bad.exitCode).not.toBe(0);
  });

  it("says plainly when no Helix serves the calling thread, and never drives another", async () => {
    const out = await fake.harness.behavior.runCli(["open", "main.go:10"], { threadId: "thr_nobody" });
    expect(out.exitCode).not.toBe(0);
    expect(`${out.stdout}${out.stderr}`).toMatch(/No Helix is connected to this thread/u);
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
    await until(() => mock.control({ cmd: "state" }).status?.message === "Comment added: 1 not sent yet");
    mock.control({ cmd: "select", line: 15, col: 1, endLine: 15, endCol: 10 });
    mock.control({ cmd: "send", kind: "comment", note: "use a constant" });
    await until(() => mock.control({ cmd: "state" }).status?.message === "Comment added: 2 not sent yet");
    expect(sent).toEqual([]);
    mock.control({ cmd: "send", kind: "flush" });
    await until(() => sent.length === 1);
    expect(sent[0]!.text).toMatch(/^Review comments from Helix \(2\)[\s\S]*1\. `main.go:6-8`[\s\S]*rename to Welcomer[\s\S]*2\. `main.go:15`[\s\S]*use a constant/u);
    await until(() => mock.control({ cmd: "state" }).status?.message === "Sent to Thread thr_term");
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

  it("lists at turn end the places the turn's edits changed, with no git", async () => {
    const scratch = join(workspace, "scratch-turn.go");
    writeFileSync(scratch, "package main\n\nfunc a() {}\n\nfunc b() {}\n");
    const gitCalls: string[] = [];
    await teardown();
    await setup({ BB_THREAD_ID: "thr_term" }, {
      plugins: {
        list: async () => [],
        callRpc: async ({ pluginId, method }: { pluginId: string; method: string }) => {
          gitCalls.push(`${pluginId} ${method}`);
          throw new Error("no git on turns");
        },
      },
    });
    try {
      const thread = makeThreadResponse({ id: "thr_term", environmentId: "env_test" });
      const lists = () => mock.control({ cmd: "state" }).lists as Record<string, number>;
      let served = false;
      fake.harness.sdk.stub("threads.events.list", async () => [{ seq: 40 }] as never);
      fake.harness.sdk.stub("threads.events.wait", async ({ afterSeq }: { afterSeq?: string }) => {
        if (afterSeq === "40" && !served) {
          served = true;
          writeFileSync(scratch, "package main\n\nfunc a() { x() }\n\nfunc b() {}\n\nfunc c() {}\n");
          const diff = `--- a${scratch}\n+++ b${scratch}\n-func a() {}\n+func a() { x() }\n \n func b() {}\n+\n+func c() {}\n`;
          return { seq: 41, createdAt: Date.now(), data: { item: { type: "fileChange", status: "completed", changes: [{ path: scratch, kind: "update", diff }] } } } as never;
        }
        await wait(50);
        return null as never;
      });
      await fake.harness.behavior.emitThreadEvent("thread.active", { thread });
      await until(() => served);
      await wait(300);
      await fake.harness.behavior.emitThreadEvent("thread.idle", { thread, lastAssistantText: null });
      await until(() => lists().changes === 2);
      // A turn that changed nothing leaves that list alone.
      await fake.harness.behavior.emitThreadEvent("thread.active", { thread });
      await wait(100);
      await fake.harness.behavior.emitThreadEvent("thread.idle", { thread, lastAssistantText: null });
      await wait(300);
      expect(lists().changes).toBe(2);
      expect(gitCalls.filter((c) => c.startsWith("bb--git"))).toEqual([]);
    } finally {
      rmSync(scratch, { force: true });
    }
  });


  it("places every changed block of a diff", () => {
    const text = "a\nB\nc\nd\nE\nF\n";
    expect(placesOf("--- a/x\n+++ b/x\n-b\n+B\n c\n d\n-e\n+E\n+F\n", text)).toEqual([{ line: 2, label: "+1 -1" }, { line: 5, endLine: 6, label: "+2 -1" }]);
    expect(placesOf("--- /dev/null\n+++ b/x\n+a\n+b\n", "a\nb\n")).toEqual([{ line: 1, endLine: 2, label: "+2 new file" }]);
    expect(placesOf("--- a/x\n+++ b/x\n-gone\n", text)).toEqual([]);
    // An edit tool's strings can start or end inside a line (the real turn's util.go edit).
    const go = 'package main\n\nfunc shout(s string) string {\n\treturn s + "!!" // take 7\n}\n';
    expect(placesOf('--- a/u.go\n+++ b/u.go\n-\treturn s + "!"\n+\treturn s + "!!"\n', go)).toEqual([{ line: 4, label: "+1 -1" }]);
    expect(placesOf('--- a/u.go\n+++ b/u.go\n-x string {\n+s string) string {\n+\treturn s + "!!"\n', go)).toEqual([{ line: 3, endLine: 4, label: "+2 -1" }]);
    // Whole lines win over a part of an earlier line.
    expect(placesOf("--- a/x\n+++ b/x\n-q\n+c\n", "abc\nc\n")).toEqual([{ line: 2, label: "+1 -1" }]);
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

describe("what the editor page takes from Helix", () => {
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

  it("opens the page's comment box and runs :bb-emit actions only for a Helix the page draws", async () => {
    await teardown();
    await setup({ BB_THREAD_ID: "thr_term", BB_TERMINAL_SESSION_ID: "term_helix1" });
    await until(() => (mock.control({ cmd: "state" }).subscriptions as string[][]).some((s) => s.includes("commentPrompt") && s.includes("action")));
    mock.control({ cmd: "select", path: "main.go", line: 2, col: 1, endLine: 3, endCol: 1 });
    expect(mock.control({ cmd: "comment" })).toMatchObject({ emitted: true });
    const box = await until(() => fake.harness.inspection.realtimeSignals.find((s) => s.channel === "commentRequest"));
    expect(box.payload).toMatchObject({ threadId: "thr_term", request: { path: join(workspace, "main.go"), ranges: [{ start: { line: 2 } }], screen: { rows: 40, cols: 120 } } });
    expect(mock.control({ cmd: "emit", name: "review.next-file" })).toMatchObject({ emitted: true });
    const action = await until(() => fake.harness.inspection.realtimeSignals.find((s) => s.channel === "action"));
    expect(action.payload).toMatchObject({ threadId: "thr_term", name: "review.next-file", args: [] });
    // The box keeps the comment (here: Review Editor is not running) and the Comments tab lists it.
    const created = (await fake.harness.behavior.callRpc("createComment", { threadId: "thr_term", path: "main.go", startLine: 2, endLine: 3, snippet: "a\nb", languageId: "go", modified: false, body: "Why two lines?" })) as { kept: string };
    expect(created.kept).toBe("local");
    const list = (await fake.harness.behavior.callRpc("comments", { threadId: "thr_term" })) as { comments: { body: string; state: string; path: string }[]; unsent: number };
    expect(list.unsent).toBe(1);
    expect(list.comments[0]).toMatchObject({ body: "Why two lines?", state: "unsent", path: "main.go" });
  });

  it("leaves the comment prompt and actions to Helix in the user's own terminal", async () => {
    await teardown();
    await setup({ BB_TERMINAL_SESSION_ID: "term_users1" });
    await until(() => (mock.control({ cmd: "state" }).subscriptions as string[][]).some((s) => s.includes("send")));
    await wait(100);
    const subs = (mock.control({ cmd: "state" }).subscriptions as string[][]).flat();
    expect(subs.includes("commentPrompt") || subs.includes("action")).toBe(false);
    expect(mock.control({ cmd: "comment" })).toMatchObject({ emitted: false, prompt: true });
  });

});

describe("the native file tree", () => {
  const filesSignals = () => fake.harness.inspection.realtimeSignals.filter((s) => s.channel === "files-changed").map((s) => s.payload);

  it("lists the thread's workspace, changes it and says which folders changed", async () => {
    mkdirSync(join(filesRoot, "pkg"));
    writeFileSync(join(filesRoot, "main.go"), "package main");
    const listed = await fake.harness.behavior.callRpc("filesList", { threadId: "thr_files", dirs: ["", "pkg"] });
    expect(listed).toEqual({
      root: filesRoot,
      dirs: { "": { entries: [{ name: "pkg", kind: "dir" }, { name: "main.go", kind: "file" }], error: null, truncated: false }, pkg: { entries: [], error: null, truncated: false } },
    });
    expect(await fake.harness.behavior.callRpc("filesOp", { threadId: "thr_files", op: { kind: "create", path: "pkg/a/b.go" } })).toEqual({ ok: true, error: null, paths: ["pkg/a/b.go"] });
    expect(filesSignals()).toEqual([{ threadId: "thr_files", dirs: expect.arrayContaining(["pkg", "pkg/a"]) }]);
    expect(await fake.harness.behavior.callRpc("filesOp", { threadId: "thr_files", op: { kind: "copy", from: ["main.go"], into: "" } })).toEqual({ ok: true, error: null, paths: ["main_1.go"] });
    expect(await fake.harness.behavior.callRpc("filesOp", { threadId: "thr_files", op: { kind: "rename", from: "main_1.go", to: "main.go" } })).toEqual({ ok: false, error: "main.go is taken", paths: [] });
    expect(await fake.harness.behavior.callRpc("filesOp", { threadId: "thr_files", op: { kind: "delete", paths: [".git"] } })).toMatchObject({ ok: false });
    expect(filesSignals()).toHaveLength(2);
  });

  it("refuses what the contract does not allow before the host sees it", async () => {
    await expect(fake.harness.behavior.callRpc("filesList", { threadId: "thr_files", dirs: [] })).rejects.toThrow();
    await expect(fake.harness.behavior.callRpc("filesList", { threadId: "thr_files", dirs: Array.from({ length: 65 }, (_, i) => `d${i}`) })).rejects.toThrow();
    await expect(fake.harness.behavior.callRpc("filesOp", { threadId: "thr_files", op: { kind: "chmod", path: "a" } })).rejects.toThrow();
  });

  it("opens a file in the thread's Helix at once, and reveals the editor", async () => {
    expect(await fake.harness.behavior.callRpc("filesOpen", { threadId: "thr_term", path: "util.go" })).toEqual({ ok: true, error: null });
    await until(() => (mock.control({ cmd: "state" }).state as { focused: { path: string } }).focused.path === join(workspace, "util.go"));
    expect(fake.harness.inspection.realtimeSignals.some((s) => s.channel === "reveal" && (s.payload as { threadId: string }).threadId === "thr_term")).toBe(true);
    expect(await fake.harness.behavior.callRpc("filesOpen", { threadId: "thr_term", path: "../util.go" })).toMatchObject({ ok: false, error: expect.stringMatching(/\.\./u) });
    expect(await fake.harness.behavior.callRpc("filesOpen", { threadId: "thr_files", path: "main.go" })).toEqual({ ok: false, error: "No Helix is open for this thread" });
  });

  it("tells the tree to read again when a turn ends there, at most once a second", async () => {
    const thread = makeThreadResponse({ id: "thr_files", environmentId: "env_files" });
    await fake.harness.behavior.emitThreadEvent("thread.idle", { thread, lastAssistantText: null });
    await fake.harness.behavior.emitThreadEvent("thread.idle", { thread, lastAssistantText: null });
    expect(filesSignals()).toEqual([{ threadId: "thr_files", dirs: null }]);
    await until(() => filesSignals().length === 2, 2500);
    expect(filesSignals()[1]).toEqual({ threadId: "thr_files", dirs: null });
  });
});

describe("the file tree and the agent", () => {
  const ask = (input: Record<string, unknown>) => fake.harness.behavior.callRpc("filesAsk", { threadId: "thr_files", ...input });

  it("asks the thread about entries, as bb's own file mentions, queued behind a running turn", async () => {
    mkdirSync(join(filesRoot, "services/auth"), { recursive: true });
    writeFileSync(join(filesRoot, "services/auth/session.go"), "package auth");
    expect(await ask({ kind: "ask", paths: ["services/auth/session.go", "services/auth"], text: "  How do these relate?  " })).toEqual({ ok: true, error: null });
    expect(sentArgs).toHaveLength(1);
    const [{ threadId, mode, input }] = sentArgs as [(typeof sentArgs)[number]];
    expect({ threadId, mode }).toEqual({ threadId: "thr_files", mode: "queue-if-active" });
    const text = "@services/auth/session.go @services/auth\n\nHow do these relate?";
    expect(input).toEqual([
      {
        type: "text",
        text,
        mentions: [
          { start: 0, end: 25, resource: { kind: "path", source: "workspace", path: "services/auth/session.go", label: "services/auth/session.go", entryKind: "file" } },
          { start: 26, end: 40, resource: { kind: "path", source: "workspace", path: "services/auth", label: "services/auth", entryKind: "directory" } },
        ],
      },
    ]);
    expect(text.slice(0, 25)).toBe("@services/auth/session.go");
    expect(text.slice(26, 40)).toBe("@services/auth");
  });

  it("asks the thread to write a file that is not there yet", async () => {
    mkdirSync(join(filesRoot, "pkg"));
    expect(await ask({ kind: "write", paths: ["pkg/new/token.go"], text: "A token type with an expiry." })).toEqual({ ok: true, error: null });
    expect(sentArgs[0]?.input[0]).toEqual({
      type: "text",
      text: "Create @pkg/new/token.go.\n\nA token type with an expiry.",
      mentions: [{ start: 7, end: 24, resource: { kind: "path", source: "workspace", path: "pkg/new/token.go", label: "pkg/new/token.go", entryKind: "file" } }],
    });
  });

  it("refuses, and sends nothing, for paths the file methods refuse, a taken name, or no words", async () => {
    writeFileSync(join(filesRoot, "main.go"), "");
    symlinkSync(tmpdir(), join(filesRoot, "out"));
    const refusals: [Record<string, unknown>, RegExp][] = [
      [{ kind: "ask", paths: ["../etc/passwd"], text: "what?" }, /"\.\." part/u],
      [{ kind: "ask", paths: ["/etc/passwd"], text: "what?" }, /Not a path in the workspace/u],
      [{ kind: "ask", paths: ["gone.go"], text: "what?" }, /gone\.go is not there/u],
      [{ kind: "ask", paths: ["main.go"], text: "   " }, /Write what to ask/u],
      [{ kind: "write", paths: ["main.go"], text: "a main" }, /main\.go is taken/u],
      [{ kind: "write", paths: ["a.go", "b.go"], text: "two" }, /One file at a time/u],
      [{ kind: "write", paths: ["out/x.go"], text: "outside" }, /leads out of the workspace/u],
      [{ kind: "write", paths: [".git/hooks/x"], text: "a hook" }, /\.git is not changed/u],
    ];
    for (const [input, why] of refusals) expect(await ask(input)).toEqual({ ok: false, error: expect.stringMatching(why) });
    expect(sentArgs).toEqual([]);
    await expect(ask({ kind: "ask", paths: Array.from({ length: 51 }, (_, i) => `f${i}`), text: "x" })).rejects.toThrow();
    await expect(ask({ kind: "ask", paths: ["main.go"], text: "x".repeat(4001) })).rejects.toThrow();
    await expect(ask({ kind: "ask", paths: [], text: "x" })).rejects.toThrow();
    expect(await fake.harness.behavior.callRpc("filesAsk", { threadId: "thr_nobody", kind: "ask", paths: ["a.go"], text: "x" })).toMatchObject({ ok: false });
  });

  it("keeps the agent's trail: the running turn's files as they land, then the last turn's", async () => {
    const thread = makeThreadResponse({ id: "thr_files", environmentId: "env_files" });
    const agentFiles = () => fake.harness.behavior.callRpc("agentFiles", { threadId: "thr_files" }) as Promise<{ running: boolean; files: { path: string; change: string; turn: string }[] }>;
    const signals = () => fake.harness.inspection.realtimeSignals.filter((s) => s.channel === "agent-files");
    const queue: unknown[] = [];
    let seq = 100;
    fake.harness.sdk.stub("threads.events.list", async () => [{ seq: 100 }] as never);
    fake.harness.sdk.stub("threads.events.wait", async () => {
      const item = queue.shift();
      if (!item) {
        await wait(20);
        return null as never;
      }
      seq += 1;
      return { seq, createdAt: Date.now(), data: { item } } as never;
    });
    const change = (changes: Record<string, unknown>[]) => ({ type: "fileChange", status: "completed", changes });
    // No Helix serves env_files: the tree having read it is what follows the turn.
    expect(await agentFiles()).toEqual({ running: false, files: [] });
    await fake.harness.behavior.callRpc("filesList", { threadId: "thr_files", dirs: [""] });
    await fake.harness.behavior.emitThreadEvent("thread.active", { thread });
    expect(await agentFiles()).toEqual({ running: true, files: [] });
    queue.push(
      change([{ path: join(filesRoot, "new.go"), kind: "add", diff: "+package main\n" }, { path: "main.go", kind: "update", diff: "-a\n+b\n" }]),
      change([{ path: "old.go", kind: "delete" }, { path: "a.go", kind: "update", movePath: "b.go" }, { path: "/elsewhere/x.go", kind: "update" }]),
      change([{ path: "made-and-gone.go", kind: "add" }]),
      change([{ path: "made-and-gone.go", kind: "delete" }]),
      { type: "fileChange", status: "failed", changes: [{ path: "failed.go", kind: "update" }] },
    );
    await until(async () => queue.length === 0 && (await agentFiles()).files.length === 5);
    await wait(100);
    const running = await agentFiles();
    expect(running.running).toBe(true);
    expect(running.files.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: "a.go", change: "deleted", turn: "running" },
      { path: "b.go", change: "created", turn: "running" },
      { path: "main.go", change: "edited", turn: "running" },
      { path: "new.go", change: "created", turn: "running" },
      { path: "old.go", change: "deleted", turn: "running" },
    ]);
    await fake.harness.behavior.emitThreadEvent("thread.idle", { thread, lastAssistantText: null });
    const last = await agentFiles();
    expect(last.running).toBe(false);
    expect(last.files.every((f) => f.turn === "last")).toBe(true);
    expect(last.files).toHaveLength(5);
    // The next turn starts empty and the last one stays until it ends.
    await fake.harness.behavior.emitThreadEvent("thread.active", { thread });
    queue.push(change([{ path: "main.go", kind: "update" }]));
    await until(async () => (await agentFiles()).files.some((f) => f.turn === "running"));
    const next = await agentFiles();
    expect(next.files.find((f) => f.path === "main.go")).toEqual({ path: "main.go", change: "edited", turn: "running" });
    expect(next.files.filter((f) => f.turn === "last").map((f) => f.path).sort()).toEqual(["a.go", "b.go", "new.go", "old.go"]);
    await fake.harness.behavior.emitThreadEvent("thread.idle", { thread, lastAssistantText: null });
    expect((await agentFiles()).files).toEqual([{ path: "main.go", change: "edited", turn: "last" }]);
    // Said over realtime (the four-a-second limit: test/files.test.ts).
    await wait(300);
    expect(signals().length).toBeGreaterThanOrEqual(2);
    expect(signals().every((s) => JSON.stringify(s.payload) === JSON.stringify({ threadId: "thr_files" }))).toBe(true);
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
