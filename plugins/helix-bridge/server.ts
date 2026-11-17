// Helix Bridge backend.
//
// Helix instances live on hosts; the host entry (host.ts) holds their sockets
// and sends each host's state as a coalesced signal. Here: which thread each
// instance belongs to (server/bridge.ts), what `:bb-*` sends become
// (server/sends.ts), following the agent's edits (server/follow.ts), the
// `bb hx` CLI, the agent tools, and the app's RPC.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostContract, hostSignals } from "./shared/host-contract";
import { Bridge, BridgeFailure, type BoundInstance } from "./server/bridge";
import { registerCli } from "./server/cli";
import { rpcContract, tags, type AppInstance, type Position } from "./server/contract";
import { Annotator } from "./server/annotations";
import { Follower } from "./server/follow";
import { AgentWatcher } from "./server/watch";
import { displayPath, lastLine, rootsOf } from "./server/format";
import { SendHandler } from "./server/sends";
import { Tree } from "./server/tree";
import { HelixService } from "./server/service";
import { MIGRATIONS, Store } from "./server/store";
import { INSTRUCTIONS, TOOL_NAMES, registerTools } from "./server/tools";

export { rpcContract } from "./server/contract";
export type { AppInstance, Position } from "./server/contract";
export type { GhosttyConfig } from "./shared/host-contract";

export const SKILL_NAME = "helix-bridge";
const RECONCILE_MS = 30_000;
const POSITION_INTERVAL_MS = 120;
export const TERMINAL_TITLE = "Helix";
export const POSITION_PROVIDER = "position";

/** The plugin directory: the source tree, or the parent of dist/ for a bundle. */
function pluginRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return here.endsWith("/dist") ? dirname(here) : here;
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    hxbPath: { type: "string", label: "Editor binary", description: "The Helix fork to run, a name on PATH or an absolute path.", default: "hxb" },
    autoReload: { type: "boolean", label: "Reload buffers when files change", description: "Reload Helix's unchanged buffers when bb sees files change. Buffers with unsaved changes are never touched.", default: true },
    followAgent: { type: "boolean", label: "Follow the agent", description: "When a turn ends, give Helix the list of places the agent changed (:bb-next walks it).", default: true },
    treeStaysOpen: { type: "boolean", label: "Keep the file tree open", description: "Keep the file tree showing after you open a file from it. Off: opening a file closes the tree and puts you in Helix.", default: false },
    positionInMessages: { type: "boolean", label: "Attach the editor position to every message", description: "On: messages you send from a thread with a bound Helix carry one line with the file and line you are on, with a chip and toggle above the composer. Off: nothing is added; the composer's Helix button attaches the position to one message.", default: false },
    hud: { type: "boolean", label: "Performance and key HUD", description: "Show key-to-paint timing, redraw time and the last key over the editor surface.", default: false },
    fontFamily: { type: "string", label: "Editor font", description: "Overrides the font from your Ghostty config. Empty uses Ghostty's.", default: "" },
    fontStyle: { type: "string", label: "Editor font style", description: "Overrides Ghostty's font-style (for example Bold, Medium, Regular). Empty uses Ghostty's.", default: "" },
    fontSize: { type: "number", label: "Editor font size", description: "Overrides Ghostty's font-size. 0 uses Ghostty's.", experimental_schema: z.number().min(0).max(48), default: 0 },
    bridgeDir: { type: "string", label: "Bridge directory", description: "Where Helix registers its sockets. Empty follows Helix: $XDG_CACHE_HOME/helix/bridge or ~/.cache/helix/bridge.", default: "" },
  } as const);

  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const store = new Store(db);
  const host = bb.hosts.experimental_client({ contract: hostContract, experimental_signals: hostSignals });
  const hostCall = (method: string, input: Record<string, unknown>, options: { hostId: string; timeoutMs?: number; signal?: AbortSignal }) =>
    host.call(method as keyof typeof hostContract & string, input as never, options);

  const skippedByInstance = new Map<string, string[]>();
  const openingTerminals = new Map<string, Promise<{ terminalId: string; created: boolean }>>();
  let lastPositionsAt = 0;
  let positionTimer: ReturnType<typeof setTimeout> | null = null;

  const bridge = new Bridge({
    sdk: () => bb.sdk,
    host: { call: hostCall },
    store,
    bridgeDir: async () => (await settings.get()).bridgeDir,
    log: (message) => bb.log.warn(message),
    onChange: (kind) => {
      if (kind === "structure") {
        bb.rpc.experimental_invalidate([tags.instances]);
        bb.realtime.publish("instances", {});
      }
      annotator.onInstances();
      // A Helix that connects mid-turn: follow that turn's edits from now on.
      for (const [environmentId, threads] of activeByEnvironment) for (const threadId of threads) watcher.start(threadId, environmentId);
      schedulePositions();
    },
  });

  const service = new HelixService({
    sdk: () => bb.sdk,
    bridge,
    settings: () => settings.get(),
    host: { call: hostCall },
    reveal: (threadId) => bb.realtime.publish("reveal", { threadId }),
  });
  const tree = new Tree({
    sdk: () => bb.sdk,
    service,
    hostCall: (method, input, hostId) => hostCall(method, input as Record<string, unknown>, { hostId, timeoutMs: 15_000 }),
    bridgeDir: async () => (await settings.get()).bridgeDir,
  });

  const sends = new SendHandler({
    sdk: () => bb.sdk,
    service,
    store,
    commentsChanged: () => void annotator.refresh(),
    // :bb-files: the editor page for that thread shows its tree on the file.
    filesRequested: (threadId, path) => bb.realtime.publish("files", { threadId, path, at: Date.now() }),
    draftReady: (threadId) => {
      bb.rpc.experimental_invalidate([tags.drafts(threadId)]);
      bb.realtime.publish("draft", { threadId });
    },
    log: (message) => bb.log.warn(message),
  });

  const annotator = new Annotator({
    sdk: () => bb.sdk,
    service,
    store,
    reviewEditorRunning: () => sends.reviewEditorRunning(),
    log: (message) => bb.log.warn(message),
  });

  const watcher = new AgentWatcher({
    sdk: () => bb.sdk,
    service,
    settings: () => settings.get(),
    log: (message) => bb.log.warn(message),
    timing: (edit, ms, instance) => bb.log.info(`agent edit in ${edit.paths.length} file(s) reached ${instance.key} ${ms} ms after bb recorded it`),
  });

  // Which environments have a turn running, so file changes there count as agent edits.
  const activeByEnvironment = new Map<string, Set<string>>();
  const setActive = (threadId: string, environmentId: string | null, active: boolean) => {
    if (active) watcher.start(threadId, environmentId);
    else watcher.stop(threadId);
    if (!environmentId) return;
    const set = activeByEnvironment.get(environmentId) ?? new Set<string>();
    if (active) set.add(threadId);
    else set.delete(threadId);
    activeByEnvironment.set(environmentId, set);
  };
  const follower = new Follower({
    sdk: () => bb.sdk,
    service,
    settings: () => settings.get(),
    watching: (environmentId) => watcher.watching(environmentId),
    log: (message) => bb.log.warn(message),
    skipped: (instance, paths) => {
      skippedByInstance.set(instance.key, paths);
      bb.rpc.experimental_invalidate([tags.instances]);
    },
  });

  // ----- positions: the thread shows where the user is, over realtime only ---

  function positions(): Position[] {
    return bridge.list().map((i) => ({
      key: i.key,
      threadId: i.threadId,
      path: i.summary.focus?.path ? displayPath(i.summary.focus.path, rootsOf(i)) : null,
      absolutePath: i.summary.focus?.path ?? null,
      line: i.summary.focus?.cursor?.line ?? null,
      col: i.summary.focus?.cursor?.col ?? null,
      endLine: i.summary.focus?.cursor ? lastLine(i.summary.focus.cursor, i.summary.focus.anchor) : null,
      mode: i.summary.mode,
    }));
  }

  function schedulePositions(): void {
    if (positionTimer) return;
    const wait = Math.max(0, POSITION_INTERVAL_MS - (Date.now() - lastPositionsAt));
    positionTimer = setTimeout(() => {
      positionTimer = null;
      lastPositionsAt = Date.now();
      bb.realtime.publish("position", { positions: positions() });
    }, wait);
  }

  // ----- sends from Helix ----------------------------------------------------

  const draining = new Map<string, Promise<void>>();
  function drainSends(hostId: string): Promise<void> {
    const running = draining.get(hostId);
    if (running) return running;
    const work = (async () => {
      const { sends: pending } = (await hostCall("pendingSends", {}, { hostId, timeoutMs: 10_000 })) as { sends: { id: string; instanceId: string; receivedAt: number; event: Record<string, unknown> }[] };
      if (pending.length === 0) return;
      const handled: string[] = [];
      for (const record of pending) {
        const outcome = await sends.handle(record, bridge.get(`${hostId}:${record.instanceId}`));
        bb.log.info(`send ${String(record.event.kind)} from ${hostId}:${record.instanceId}: ${outcome}`);
        handled.push(record.id);
      }
      await hostCall("ackSends", { ids: handled }, { hostId, timeoutMs: 10_000 });
    })()
      .catch((error: unknown) => bb.log.warn(`draining sends on ${hostId} failed: ${String(error)}`))
      .finally(() => draining.delete(hostId));
    draining.set(hostId, work);
    return work;
  }

  host.experimental_onSignal("state", ({ hostId, payload }) => {
    bridge.onState(hostId, payload);
    if (payload.instances.some((i) => i.pendingSends > 0)) void drainSends(hostId);
  });
  host.experimental_onWorkerExit(({ hostId }) => {
    bridge.onWorkerExit(hostId);
    void bridge.reconcile().catch(() => {});
  });

  // ----- app RPC ---------------------------------------------------------------

  async function appInstance(instance: BoundInstance): Promise<AppInstance> {
    const roots = rootsOf(instance);
    const focus = instance.summary.focus;
    const title = instance.threadId ? (await service.threadInfo(instance.threadId)).title : null;
    return {
      key: instance.key,
      hostId: instance.hostId,
      pid: instance.summary.pid,
      status: instance.summary.status,
      error: instance.summary.error,
      helixVersion: instance.summary.helixVersion,
      workspaceRoot: instance.summary.workspaceRoot,
      threadId: instance.threadId,
      threadTitle: title,
      bindingSource: instance.bindingSource,
      terminalId: instance.summary.env.BB_TERMINAL_ID ?? null,
      focus: focus
        ? { path: focus.path ? displayPath(focus.path, roots) : null, absolutePath: focus.path, line: focus.cursor?.line ?? null, col: focus.cursor?.col ?? null, endLine: focus.cursor ? lastLine(focus.cursor, focus.anchor) : null, modified: focus.modified }
        : null,
      mode: instance.summary.mode,
      diagnostics: instance.summary.diagnostics,
      capabilities: instance.summary.capabilities,
      commandPolicy: instance.summary.commandPolicy,
      pendingSends: instance.summary.pendingSends,
      skippedModified: (skippedByInstance.get(instance.key) ?? []).map((p) => displayPath(p, roots)),
    };
  }

  const refuse = (error: unknown): never => {
    if (error instanceof BridgeFailure) throw new Error(error.message);
    throw error;
  };

  bb.rpc.register(rpcContract, {
    instances: async () => ({ instances: await Promise.all(bridge.list().map(appInstance)), hosts: bridge.hostStates() }),
    threadStatus: async ({ threadId }) => {
      const serving = await service.instancesForThread(threadId);
      return { instance: serving[0] ? await appInstance(serving[0]) : null, candidates: bridge.list().length };
    },
    bind: async ({ instanceKey, threadId }) => appInstance(await bridge.bind(instanceKey, threadId).catch(refuse)),
    unbind: async ({ instanceKey }) => appInstance((await bridge.unbind(instanceKey).catch(refuse)).instance),
    reload: async ({ instanceKey }) => {
      const instance = bridge.get(instanceKey);
      if (!instance) throw new Error(`no Helix instance ${instanceKey}`);
      const result = await follower.reload(instance);
      return { reloaded: result?.reloaded.length ?? 0, skippedModified: (result?.skippedModified ?? []).map((p) => displayPath(p, rootsOf(instance))) };
    },
    drafts: ({ threadId }) => ({ drafts: store.drafts(threadId) }),
    takeDraft: ({ id }) => ({ taken: store.takeDraft(id) }),
    setup: async () => {
      const values = await settings.get();
      const ghostty = await service.ghostty(null).catch(() => null);
      const result = await service.doctor(null, values.fontFamily.trim() || ghostty?.fontFamily || null);
      return { ready: !result.checks.some((c) => c.level === "error"), checks: result.checks.map(({ id: checkId, label, level, detail, fix }) => ({ id: checkId, label, level, detail, fix })) };
    },
    ghostty: async (input) => {
      const values = await settings.get();
      // The surface's font: Ghostty's, with this plugin's overrides (and, for
      // the font check in spike/, a style asked for by the page).
      const fontFamily = values.fontFamily.trim();
      const fontStyle = input?.fontStyle?.trim() || values.fontStyle.trim();
      const config = await service.ghostty(null, { ...(fontFamily ? { fontFamily } : {}), ...(fontStyle ? { fontStyle } : {}) });
      return { ...config, ...(values.fontSize > 0 ? { fontSize: values.fontSize } : {}), hud: values.hud };
    },
    commentsChanged: ({ environmentId, path }) => {
      void annotator.refreshFile(environmentId, path);
      return { accepted: true };
    },
    treeTerminal: ({ threadId }) => tree.terminal(threadId),
    treeReveal: async ({ threadId, path }) => ({ ok: await tree.reveal(threadId, path).catch(() => false) }),
    treeClose: async ({ threadId }) => ({ closed: await tree.close(threadId).catch(() => false) }),
    editorTerminal: ({ threadId }) => {
      // One session per thread: concurrent opens (page and tab) share one call.
      const running = openingTerminals.get(threadId);
      if (running) return running;
      const work = (async () => {
        const { sessions } = await bb.sdk.terminals.list({ scope: { kind: "thread", threadId } });
        const existing = sessions.find((t) => t.title === TERMINAL_TITLE && (t.status === "running" || t.status === "starting"));
        if (existing) return { terminalId: existing.id, created: false };
        const { hxbPath } = await settings.get();
        // bb's terminals do not export BB_THREAD_ID and friends, which Helix
        // records in its registry file to say which thread it belongs to; set
        // them for the session we start. bb's terminal answers the
        // device-attributes query itself, so Helix cannot detect that the
        // surface speaks the Kitty keyboard protocol: tell it.
        const thread = await bb.sdk.threads.get({ threadId });
        const vars = [`BB_THREAD_ID=${threadId}`, ...(thread.environmentId ? [`BB_ENVIRONMENT_ID=${thread.environmentId}`] : []), ...(thread.projectId ? [`BB_PROJECT_ID=${thread.projectId}`] : []), "HELIX_KITTY_KEYBOARD=enabled"];
        const command = `${vars.map(shellQuote).join(" ")} exec ${shellQuote(hxbPath.trim() || "hxb")}`;
        const created = await bb.sdk.terminals.create({ scope: { kind: "thread", threadId }, title: TERMINAL_TITLE, cols: 160, rows: 48, start: { mode: "command", command } });
        return { terminalId: created.id, created: true };
      })().finally(() => openingTerminals.delete(threadId));
      openingTerminals.set(threadId, work);
      return work;
    },
  });

  // The wterm renderer's Ghostty core, served beside app.js.
  bb.http.route("GET", "/wterm-ghostty.wasm", async () => {
    const candidates = [join(pluginRoot(), "assets", "ghostty-vt.wasm"), join(pluginRoot(), "node_modules", "@wterm", "ghostty", "wasm", "ghostty-vt.wasm")];
    const file = candidates.find((p) => existsSync(p));
    if (!file) return new Response("ghostty-vt.wasm is missing", { status: 404 });
    return new Response(await readFile(file), { headers: { "content-type": "application/wasm", "cache-control": "no-cache" } });
  });

  // A new bridge directory (or binary) takes effect at once on every host.
  settings.onChange((next, previous) => {
    if (next.bridgeDir !== previous.bridgeDir) void bridge.reconcile().catch((error: unknown) => bb.log.warn(`reconcile failed: ${String(error)}`));
    if (next.hxbPath !== previous.hxbPath || next.bridgeDir !== previous.bridgeDir) bb.rpc.experimental_invalidate([tags.setup]);
  });

  registerCli(bb, service, {
    // A file chosen in the tree went to Helix: the app moves focus there.
    treeOpened: (threadId) => bb.realtime.publish("tree-open", { threadId, at: Date.now() }),
  });
  registerTools(bb, service);

  // The editor position on outgoing messages: the composer keeps a "Helix"
  // pill in the draft (its toggle), and this resolves it at send time into
  // one agent-only line. Resolve never throws, so it can never block a send.
  bb.ui.registerMentionProvider({
    id: POSITION_PROVIDER,
    label: "Helix",
    search: async ({ threadId }) => {
      if (!threadId || (await service.instancesForThread(threadId)).length === 0) return [];
      return [{ id: threadId, title: "Helix position", subtitle: "The file and line you are on, attached when you send", icon: "Code" }];
    },
    resolve: async (itemId) => {
      if (!/^[A-Za-z0-9_-]{1,64}$/u.test(itemId)) return { context: "Helix editor position: not available." };
      try {
        return { context: await service.positionLine(itemId) };
      } catch {
        return { context: "Helix editor position: not available." };
      }
    },
  });

  // Tools are offered only to a thread a connected Helix serves. bb builds a
  // session's tool list when the session starts, so a thread that started
  // before Helix connected gets them on its next session.
  bb.agents.configure((context) => {
    // Only the tools whose capability the connected Helix offers (bridge/hello).
    const tools = service.toolsForThreadSync(context.thread.id, { id: context.environment.id, path: context.environment.path }, context.host.id);
    return tools.length > 0 ? { tools, skills: [SKILL_NAME], instructions: INSTRUCTIONS } : { tools: [], skills: [SKILL_NAME] };
  });

  // ----- background ------------------------------------------------------------

  bb.background.service("reconcile", {
    async start(signal) {
      while (!signal.aborted) {
        try {
          await bridge.reconcile(signal);
          for (const state of bridge.hostStates()) if (bridge.list().some((i) => i.hostId === state.hostId && i.summary.pendingSends > 0)) await drainSends(state.hostId);
        } catch (error) {
          if (!signal.aborted) bb.log.warn(`reconcile failed: ${String(error)}`);
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, RECONCILE_MS);
          signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
        });
      }
    },
  });

  bb.background.service("environment-changes", {
    async start(signal) {
      // Turns already running when this plugin (re)loaded; never holds up the
      // subscription below.
      void (async () => {
        const running = await bb.sdk.threads.listRunning();
        if (running.length === 0) return;
        const threads = await bb.sdk.threads.list({ threadIds: running.map((t) => t.id).slice(0, 200) });
        for (const thread of threads) setActive(thread.id, thread.environmentId ?? null, true);
      })().catch((error: unknown) => bb.log.warn(`could not read running threads: ${String(error)}`));
      const unsubscribe = bb.sdk.subscribe({
        event: "environment:changed",
        callback: (event) => {
          const environmentId = event.id;
          if (!environmentId) return;
          const changes = new Set(event.changes);
          if (changes.has("work-status-changed")) {
            if ((activeByEnvironment.get(environmentId)?.size ?? 0) > 0) service.noteAgentEdit(environmentId);
            follower.onEnvironmentChanged(environmentId);
          }
          if (changes.has("environment-deleted") || changes.has("metadata-changed")) bridge.forgetEnvironments();
        },
      });
      annotator.start();
      await new Promise<void>((resolve) => (signal.aborted ? resolve() : signal.addEventListener("abort", () => resolve(), { once: true })));
      unsubscribe();
      follower.dispose();
      annotator.dispose();
      watcher.dispose();
    },
  });

  bb.events.on("thread.failed", ({ thread }) => setActive(thread.id, thread.environmentId ?? null, false));
  bb.events.on("thread.active", ({ thread }) => {
    setActive(thread.id, thread.environmentId ?? null, true);
    bridge.threadActivity(thread.id, thread.environmentId ?? null);
    void follower.onTurnStart(thread.id, thread.environmentId ?? null);
  });
  bb.events.on("thread.idle", ({ thread }) => {
    setActive(thread.id, thread.environmentId ?? null, false);
    bridge.threadActivity(thread.id, thread.environmentId ?? null);
    void follower.onTurnEnd(thread.id, thread.environmentId ?? null);
  });
  for (const event of ["thread.archived", "thread.deleted", "thread.created"] as const) bb.events.on(event, ({ thread }) => bridge.threadActivity(thread.id, thread.environmentId ?? null));

  bb.onDispose(() => {
    if (positionTimer) clearTimeout(positionTimer);
    follower.dispose();
    annotator.dispose();
    watcher.dispose();
  });
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./~=-]+$/u.test(value) ? value : `'${value.replace(/'/gu, `'\\''`)}'`;
}
