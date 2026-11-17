// Every editor operation the CLI, the agent tools and the app share. Each
// takes a target instance, checks the capability the method needs (from
// `bridge/hello`; never assumed), resolves paths the way the caller means
// them, and returns plain data the formatters turn into text.
import { isAbsolute, join, normalize } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { DoctorCheck, GhosttyConfig } from "../shared/host-contract";
import type {
  Capability,
  Diagnostic,
  LayoutNode,
  LocationItem,
  OpenResult,
  QueryKind,
  Range,
  ReloadResult,
  SelectionResult,
  ViewInfo,
} from "../shared/protocol";
import { type Bridge, BridgeFailure, type BoundInstance, within } from "./bridge";

type Sdk = BbPluginApi["sdk"];

export interface ServiceDeps {
  sdk(): Sdk;
  bridge: Bridge;
  settings(): Promise<{ hxbPath: string; bridgeDir: string; fontFamily: string }>;
  host: { call(method: string, input: Record<string, unknown>, options: { hostId: string; timeoutMs?: number }): Promise<unknown> };
  /** The app wants to reveal the editor for this thread. */
  reveal(threadId: string): void;
}

const LSP_DEFAULT_TIMEOUT_MS = 10_000;

export class HelixService {
  private readonly threadEnv = new Map<string, { at: number; environmentId: string | null; hostId: string | null; path: string | null; title: string | null }>();

  constructor(private readonly deps: ServiceDeps) {}

  get bridge(): Bridge {
    return this.deps.bridge;
  }

  // ----- targets ------------------------------------------------------------

  async threadInfo(threadId: string): Promise<{ environmentId: string | null; hostId: string | null; path: string | null; title: string | null }> {
    const cached = this.threadEnv.get(threadId);
    if (cached && Date.now() - cached.at < 30_000) return cached;
    const sdk = this.deps.sdk();
    let info = { at: Date.now(), environmentId: null as string | null, hostId: null as string | null, path: null as string | null, title: null as string | null };
    try {
      const thread = await sdk.threads.get({ threadId });
      info.title = thread.title ?? null;
      info.environmentId = thread.environmentId ?? null;
      if (thread.environmentId) {
        const env = await sdk.environments.get({ environmentId: thread.environmentId });
        info = { ...info, hostId: env.hostId ?? null, path: env.path ?? null };
      }
    } catch {
      // unknown thread: no environment
    }
    this.threadEnv.set(threadId, info);
    return info;
  }

  /** Instances that serve a thread: bound to it, else in its environment. Connected first. */
  async instancesForThread(threadId: string): Promise<BoundInstance[]> {
    const all = this.bridge.list();
    const bound = all.filter((i) => i.threadId === threadId);
    const info = await this.threadInfo(threadId);
    const inEnv = all.filter((i) => !bound.includes(i) && info.hostId === i.hostId && info.path && i.summary.workspaceRoot && (within(info.path, i.summary.workspaceRoot) || within(i.summary.workspaceRoot, info.path)));
    const rank = (i: BoundInstance) => (i.summary.status === "connected" ? 0 : 1);
    return [...bound.sort((a, b) => rank(a) - rank(b) || b.summary.updatedAt - a.summary.updatedAt), ...inEnv.sort((a, b) => rank(a) - rank(b))];
  }

  /** Synchronous check for agents.configure: is an instance bound to this thread or its environment? */
  servesThreadSync(threadId: string, environment: { id: string; path: string | null } | null, hostId: string | null): boolean {
    return this.bridge.list().some(
      (i) =>
        i.summary.status === "connected" &&
        (i.threadId === threadId ||
          (environment !== null && i.environmentId === environment.id) ||
          (environment?.path && hostId === i.hostId && i.summary.workspaceRoot && within(environment.path, i.summary.workspaceRoot))),
    );
  }

  /** Pick the instance a request means. */
  async target(options: { instance?: string | undefined; threadId?: string | undefined }): Promise<BoundInstance> {
    const all = this.bridge.list();
    if (options.instance) {
      const wanted = options.instance.trim();
      const matches = all.filter((i) => i.key === wanted || i.summary.id === wanted || String(i.summary.pid) === wanted);
      if (matches.length === 1) return matches[0]!;
      if (matches.length > 1) throw new BridgeFailure("ambiguous", `"${wanted}" matches ${matches.length} instances: ${matches.map((m) => m.key).join(", ")}; pass the full key`);
      throw new BridgeFailure("not_found", `no Helix instance "${wanted}". Running: ${all.map((i) => i.key).join(", ") || "none"}`);
    }
    if (options.threadId) {
      const serving = await this.instancesForThread(options.threadId);
      if (serving[0]) return serving[0];
    }
    const connected = all.filter((i) => i.summary.status === "connected");
    if (connected.length === 1) return connected[0]!;
    if (connected.length === 0)
      throw new BridgeFailure("not_found", all.length ? `no connected Helix (${all.map((i) => `${i.key}: ${i.summary.status}`).join(", ")})` : "no Helix is running with the bridge. Start hxb, or run bb hx doctor");
    throw new BridgeFailure("ambiguous", `${connected.length} Helix instances are running and none is bound to this thread; pass --instance (one of ${connected.map((i) => i.key).join(", ")}) or bind one with bb hx bind`);
  }

  requireCapability(instance: BoundInstance, capability: Capability): void {
    if (instance.summary.status !== "connected") throw new BridgeFailure("not_connected", `Helix ${instance.key} is ${instance.summary.status}${instance.summary.error ? `: ${instance.summary.error}` : ""}`);
    if (!instance.summary.capabilities.includes(capability))
      throw new BridgeFailure("unsupported", `this Helix does not offer "${capability}" yet (it offers: ${instance.summary.capabilities.join(", ") || "nothing"})`);
  }

  /** A path as the caller meant it: absolute, or relative to the thread's workspace, else Helix's. */
  absolute(instance: BoundInstance, path: string): string {
    const trimmed = path.trim();
    if (isAbsolute(trimmed)) return normalize(trimmed);
    const base = instance.environmentPath ?? instance.summary.workspaceRoot ?? instance.summary.cwd ?? "/";
    return normalize(join(base, trimmed));
  }

  private call<T>(instance: BoundInstance, method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    return this.bridge.call<T>(instance.key, method, params, timeoutMs);
  }

  // ----- reads --------------------------------------------------------------

  async selection(instance: BoundInstance): Promise<SelectionResult> {
    this.requireCapability(instance, "editor");
    return this.call<SelectionResult>(instance, "editor/selection");
  }

  async diagnostics(instance: BoundInstance, options: { path?: string; minSeverity?: Diagnostic["severity"]; limit?: number; offset?: number }): Promise<{ items: Diagnostic[]; total: number; truncated: boolean }> {
    this.requireCapability(instance, "diagnostics");
    return this.call(instance, "diagnostics/get", {
      ...(options.path ? { path: this.absolute(instance, options.path) } : {}),
      minSeverity: options.minSeverity ?? "hint",
      limit: Math.min(500, Math.max(1, options.limit ?? 50)),
      offset: Math.max(0, options.offset ?? 0),
    });
  }

  async query(
    instance: BoundInstance,
    options: { kind: QueryKind; path?: string; line?: number; col?: number; query?: string; newName?: string; includeDeclaration?: boolean; limit?: number; timeoutMs?: number },
  ): Promise<Record<string, unknown>> {
    this.requireCapability(instance, "lsp");
    const timeoutMs = Math.min(60_000, Math.max(1000, options.timeoutMs ?? LSP_DEFAULT_TIMEOUT_MS));
    const params: Record<string, unknown> = { kind: options.kind, limit: Math.min(500, Math.max(1, options.limit ?? 100)), timeoutMs };
    if (options.path) params.path = this.absolute(instance, options.path);
    if (options.line !== undefined) params.position = { line: options.line, col: options.col ?? 1 };
    if (options.query !== undefined) params.query = options.query;
    if (options.newName !== undefined) params.newName = options.newName;
    if (options.includeDeclaration !== undefined) params.includeDeclaration = options.includeDeclaration;
    return this.call(instance, "lsp/query", params, timeoutMs + 1000);
  }

  async panes(instance: BoundInstance): Promise<{ views: ViewInfo[]; layout: LayoutNode | null }> {
    this.requireCapability(instance, "views");
    return this.call(instance, "view/list");
  }

  // ----- the agent drives the editor ------------------------------------------

  /** Take the user to a place. Deferred (the user is typing) is not a failure. */
  async show(
    instance: BoundInstance,
    options: { path: string; line?: number; col?: number; endLine?: number; endCol?: number; split?: "none" | "horizontal" | "vertical"; pane?: number; note?: string; interrupt?: "whenIdle" | "always"; focus?: boolean },
  ): Promise<OpenResult> {
    this.requireCapability(instance, "editor");
    const params: Record<string, unknown> = { path: this.absolute(instance, options.path), focus: options.focus ?? true };
    for (const key of ["line", "col", "endLine", "endCol", "note", "interrupt"] as const) if (options[key] !== undefined) params[key] = options[key];
    if (options.split && options.split !== "none") params.split = options.split;
    if (options.pane !== undefined) params.viewId = options.pane;
    const result = await this.call<OpenResult>(instance, "editor/open", params);
    if (instance.threadId && params.focus !== false) this.deps.reveal(instance.threadId);
    return result;
  }

  async tour(instance: BoundInstance, options: { title: string; list?: string; items: LocationItem[]; start?: number; interrupt?: "whenIdle" | "always" }): Promise<{ count: number; deferred?: boolean }> {
    this.requireCapability(instance, "locations");
    const items = options.items.slice(0, 2000).map((item) => ({ ...item, path: this.absolute(instance, item.path) }));
    const result = await this.call<{ count: number; deferred?: boolean }>(instance, "locations/set", {
      list: options.list ?? "tour",
      title: options.title,
      items,
      activate: true,
      ...(options.start !== undefined && items.length > 0 ? { goto: Math.min(options.start, items.length - 1) } : {}),
      ...(options.interrupt ? { interrupt: options.interrupt } : {}),
    });
    if (instance.threadId && options.start !== undefined) this.deps.reveal(instance.threadId);
    return result;
  }

  async focusPane(instance: BoundInstance, pane: number, interrupt?: "whenIdle" | "always"): Promise<{ deferred?: boolean }> {
    this.requireCapability(instance, "views");
    return this.call(instance, "view/focus", { viewId: pane, ...(interrupt ? { interrupt } : {}) });
  }

  async closePane(instance: BoundInstance, pane: number): Promise<void> {
    this.requireCapability(instance, "views");
    await this.call(instance, "view/close", { viewId: pane });
  }

  async select(instance: BoundInstance, options: { pane?: number; ranges: Range[]; primary?: number; interrupt?: "whenIdle" | "always" }): Promise<{ version: number; deferred?: boolean }> {
    this.requireCapability(instance, "views");
    return this.call(instance, "editor/select", {
      ranges: options.ranges,
      ...(options.pane !== undefined ? { viewId: options.pane } : {}),
      ...(options.primary !== undefined ? { primary: options.primary } : {}),
      ...(options.interrupt ? { interrupt: options.interrupt } : {}),
    });
  }

  async edit(instance: BoundInstance, options: { path: string; version?: number; edits: { range: Range; newText: string }[]; label?: string; save?: boolean }): Promise<{ path: string; version: number; modified: boolean }> {
    this.requireCapability(instance, "applyEdits");
    return this.call(instance, "editor/applyEdits", {
      path: this.absolute(instance, options.path),
      edits: options.edits,
      ...(options.version !== undefined ? { version: options.version } : {}),
      ...(options.label ? { label: options.label } : {}),
      save: options.save ?? false,
    });
  }

  async command(instance: BoundInstance, options: { typed?: string; static?: string; count?: number; keys?: string; interrupt?: "whenIdle" | "always" }): Promise<{ status?: { message: string; severity: string }; deferred?: boolean }> {
    this.requireCapability(instance, "command");
    const given = [options.typed, options.static, options.keys].filter((v) => v !== undefined);
    if (given.length !== 1) throw new BridgeFailure("invalid_params", "pass exactly one of typed, static or keys");
    const params: Record<string, unknown> = {};
    if (options.typed !== undefined) params.typed = options.typed.replace(/^:/u, "");
    if (options.static !== undefined) {
      params.static = options.static;
      if (options.count !== undefined) params.count = options.count;
    }
    if (options.keys !== undefined) params.keys = options.keys;
    if (options.interrupt) params.interrupt = options.interrupt;
    return this.call(instance, "editor/command", params);
  }

  async reload(instance: BoundInstance, options: { paths?: string[]; force?: boolean } = {}): Promise<ReloadResult> {
    this.requireCapability(instance, "reload");
    return this.call<ReloadResult>(instance, "editor/reload", {
      ...(options.paths?.length ? { paths: options.paths.map((p) => this.absolute(instance, p)) } : {}),
      force: options.force ?? false,
    });
  }

  async status(instance: BoundInstance, message: string, severity: "info" | "warning" | "error" = "info"): Promise<void> {
    if (instance.summary.status !== "connected" || !instance.summary.capabilities.includes("editor")) return;
    await this.call(instance, "editor/status", { message: message.slice(0, 300), severity }).catch(() => {});
  }

  // ----- setup ----------------------------------------------------------------

  async defaultHost(): Promise<string | null> {
    const sdk = this.deps.sdk();
    const config = (await sdk.system.config()) as { primaryHostId?: string | null };
    return config.primaryHostId ?? (await sdk.hosts.list()).find((h) => h.status === "connected")?.id ?? null;
  }

  /** The user's Ghostty config on a machine, read only. */
  async ghostty(hostId: string | null): Promise<GhosttyConfig> {
    const target = hostId ?? (await this.defaultHost());
    if (!target) throw new BridgeFailure("not_found", "no connected machine");
    return (await this.deps.host.call("ghosttyConfig", {}, { hostId: target, timeoutMs: 10_000 })) as GhosttyConfig;
  }

  async fontSetting(): Promise<string> {
    return (await this.deps.settings()).fontFamily.trim();
  }

  async doctor(hostId: string | null, fontFamily: string | null): Promise<{ hostId: string; checks: DoctorCheck[]; hxbResolved: string | null; hxbVersion: string | null }> {
    const settings = await this.deps.settings();
    const target = hostId ?? (await this.defaultHost());
    if (!target) throw new BridgeFailure("not_found", "no connected machine to check");
    const result = (await this.deps.host.call("doctor", { bridgeDir: settings.bridgeDir, hxbPath: settings.hxbPath, fontFamily }, { hostId: target, timeoutMs: 20_000 })) as {
      checks: DoctorCheck[];
      hxbResolved: string | null;
      hxbVersion: string | null;
    };
    return { hostId: target, ...result };
  }
}
