// The server's view of every Helix instance on every host, and which bb
// thread each one belongs to. Host state arrives as coalesced `state` signals
// and a periodic reconcile; bindings are resolved here:
//   1. `BB_THREAD_ID` from the registry file (Helix started in a bb terminal);
//   2. an explicit binding (`bb hx bind`, the app's picker);
//   3. the environment on that host whose path contains the workspace root,
//      then the most recently updated thread in it.
// Calls go to the instance's own host; no socket is ever opened here.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { BridgeCallError, InstanceSummary, hostSignals } from "../shared/host-contract";
import type { Store } from "./store";

type Sdk = BbPluginApi["sdk"];
export type HostSignals = typeof hostSignals;

export type BindingSource = "terminal" | "explicit" | "environment";

export interface BoundInstance {
  /** `<hostId>:<pid>`: unique across hosts. */
  key: string;
  hostId: string;
  summary: InstanceSummary;
  threadId: string | null;
  bindingSource: BindingSource | null;
  environmentId: string | null;
  environmentPath: string | null;
}

export class BridgeFailure extends Error {
  constructor(
    readonly name: string,
    message: string,
    readonly code = 0,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export interface BridgeDeps {
  sdk(): Sdk;
  host: {
    call(method: string, input: Record<string, unknown>, options: { hostId: string; timeoutMs?: number; signal?: AbortSignal }): Promise<unknown>;
  };
  store: Store;
  bridgeDir(): Promise<string>;
  log(message: string): void;
  /** Something the app shows changed: `structure` (instances, bindings, status) or `position`. */
  onChange(kind: "structure" | "position"): void;
}

interface HostState {
  bridgeDir: string;
  dirExists: boolean;
  instances: InstanceSummary[];
  error: string | null;
  seenAt: number;
}

interface EnvInfo {
  id: string;
  hostId: string;
  path: string;
}

const ENV_TTL_MS = 30_000;
const THREAD_TTL_MS = 15_000;

/** Whether `child` is `parent` or inside it. */
export function within(parent: string, child: string): boolean {
  const p = parent.endsWith("/") ? parent.slice(0, -1) : parent;
  return child === p || child.startsWith(`${p}/`);
}

export class Bridge {
  private readonly hosts = new Map<string, HostState>();
  private bindings = new Map<string, { threadId: string | null; source: BindingSource | null; environmentId: string | null; environmentPath: string | null }>();
  private envCache: { at: number; envs: EnvInfo[] } | null = null;
  private readonly threadCache = new Map<string, { at: number; ok: boolean; environmentId: string | null; updatedAt: string }>();
  private readonly envThreadCache = new Map<string, { at: number; threadId: string | null }>();
  private resolving: Promise<void> | null = null;
  private resolveAgain = false;
  private structureKey = "";

  constructor(private readonly deps: BridgeDeps) {}

  // ----- host state -----------------------------------------------------------

  /** Ask every connected host for its instances (also starts its watcher). */
  async reconcile(signal?: AbortSignal): Promise<void> {
    const sdk = this.deps.sdk();
    const hosts = await sdk.hosts.list();
    const live = new Set<string>();
    const bridgeDir = await this.deps.bridgeDir();
    await Promise.all(
      hosts
        .filter((h) => h.status === "connected")
        .map(async (h) => {
          live.add(h.id);
          try {
            const result = (await this.deps.host.call("instances", { bridgeDir }, { hostId: h.id, timeoutMs: 15_000, ...(signal ? { signal } : {}) })) as {
              bridgeDir: string;
              dirExists: boolean;
              instances: InstanceSummary[];
            };
            this.hosts.set(h.id, { bridgeDir: result.bridgeDir, dirExists: result.dirExists, instances: result.instances, error: null, seenAt: Date.now() });
            this.deps.store.pruneBindings(h.id, result.instances.filter((i) => i.startedAt).map((i) => ({ pid: i.pid, startedAt: i.startedAt! })));
          } catch (error) {
            const previous = this.hosts.get(h.id);
            this.hosts.set(h.id, { bridgeDir: previous?.bridgeDir ?? bridgeDir, dirExists: previous?.dirExists ?? false, instances: previous?.instances ?? [], error: error instanceof Error ? error.message : String(error), seenAt: Date.now() });
          }
        }),
    );
    for (const id of [...this.hosts.keys()]) if (!live.has(id)) this.hosts.delete(id);
    await this.resolve();
  }

  /** A host's coalesced state signal. */
  onState(hostId: string, payload: { bridgeDir: string; instances: InstanceSummary[] }): void {
    const previous = this.hosts.get(hostId);
    this.hosts.set(hostId, { bridgeDir: payload.bridgeDir, dirExists: previous?.dirExists ?? true, instances: payload.instances, error: null, seenAt: Date.now() });
    const known = new Set((previous?.instances ?? []).map((i) => `${i.id}\0${i.startedAt}`));
    const changedSet = payload.instances.some((i) => !known.has(`${i.id}\0${i.startedAt}`)) || payload.instances.length !== known.size;
    if (changedSet) void this.resolve();
    else this.notify();
  }

  onWorkerExit(hostId: string): void {
    const state = this.hosts.get(hostId);
    if (state) state.error = "the host worker restarted";
    this.notify();
  }

  hostStates(): { hostId: string; bridgeDir: string; dirExists: boolean; error: string | null; instances: number }[] {
    return [...this.hosts].map(([hostId, s]) => ({ hostId, bridgeDir: s.bridgeDir, dirExists: s.dirExists, error: s.error, instances: s.instances.length }));
  }

  // ----- bindings ------------------------------------------------------------

  list(): BoundInstance[] {
    const out: BoundInstance[] = [];
    for (const [hostId, state] of this.hosts) {
      for (const summary of state.instances) {
        const key = `${hostId}:${summary.id}`;
        const binding = this.bindings.get(key);
        out.push({
          key,
          hostId,
          summary,
          threadId: binding?.threadId ?? null,
          bindingSource: binding?.source ?? null,
          environmentId: binding?.environmentId ?? null,
          environmentPath: binding?.environmentPath ?? null,
        });
      }
    }
    return out.sort((a, b) => a.summary.pid - b.summary.pid);
  }

  get(key: string): BoundInstance | null {
    return this.list().find((i) => i.key === key) ?? null;
  }

  /** Re-resolve every instance's thread. Serialised; a request during a run reruns once. */
  resolve(): Promise<void> {
    if (this.resolving) {
      this.resolveAgain = true;
      return this.resolving;
    }
    this.resolving = (async () => {
      do {
        this.resolveAgain = false;
        try {
          await this.resolveOnce();
        } catch (error) {
          this.deps.log(`binding resolution failed: ${String(error)}`);
        }
      } while (this.resolveAgain);
    })().finally(() => {
      this.resolving = null;
      this.notify();
    });
    return this.resolving;
  }

  private async resolveOnce(): Promise<void> {
    const next = new Map<string, { threadId: string | null; source: BindingSource | null; environmentId: string | null; environmentPath: string | null }>();
    for (const [hostId, state] of this.hosts) {
      for (const summary of state.instances) {
        const key = `${hostId}:${summary.id}`;
        const env = summary.workspaceRoot ? await this.environmentFor(hostId, summary.workspaceRoot) : null;
        let threadId: string | null = null;
        let source: BindingSource | null = null;
        const fromTerminal = summary.env.BB_THREAD_ID;
        if (fromTerminal && (await this.threadAlive(fromTerminal))) {
          threadId = fromTerminal;
          source = "terminal";
        }
        if (!threadId && summary.startedAt) {
          const explicit = this.deps.store.binding(hostId, summary.pid, summary.startedAt);
          if (explicit && (await this.threadAlive(explicit))) {
            threadId = explicit;
            source = "explicit";
          }
        }
        if (!threadId && env) {
          threadId = await this.latestThreadIn(env.id);
          if (threadId) source = "environment";
        }
        // The environment that matters for following the agent is the bound
        // thread's, which may differ from the one containing the workspace.
        let environmentId = env?.id ?? null;
        let environmentPath = env?.path ?? null;
        if (threadId) {
          const thread = this.threadCache.get(threadId);
          if (thread?.environmentId && thread.environmentId !== environmentId) {
            const envs = await this.environments();
            const bound = envs.find((e) => e.id === thread.environmentId);
            if (bound) {
              environmentId = bound.id;
              environmentPath = bound.path;
            }
          }
        }
        next.set(key, { threadId, source, environmentId, environmentPath });
      }
    }
    this.bindings = next;
  }

  private async environments(): Promise<EnvInfo[]> {
    if (this.envCache && Date.now() - this.envCache.at < ENV_TTL_MS) return this.envCache.envs;
    const sdk = this.deps.sdk();
    const rows = await sdk.environments.list({});
    const envs = rows.flatMap((e) => (typeof e.hostId === "string" && typeof e.path === "string" && e.path.length > 0 ? [{ id: e.id, hostId: e.hostId, path: e.path }] : []));
    this.envCache = { at: Date.now(), envs };
    return envs;
  }

  /** The deepest environment on `hostId` whose path contains `root`. */
  async environmentFor(hostId: string, root: string): Promise<EnvInfo | null> {
    const envs = (await this.environments()).filter((e) => e.hostId === hostId && within(e.path, root));
    envs.sort((a, b) => b.path.length - a.path.length);
    return envs[0] ?? null;
  }

  private async threadAlive(threadId: string): Promise<boolean> {
    const cached = this.threadCache.get(threadId);
    if (cached && Date.now() - cached.at < THREAD_TTL_MS) return cached.ok;
    try {
      const thread = await this.deps.sdk().threads.get({ threadId });
      const ok = !thread.archivedAt && !thread.deletedAt;
      this.threadCache.set(threadId, { at: Date.now(), ok, environmentId: thread.environmentId ?? null, updatedAt: String(thread.updatedAt ?? "") });
      return ok;
    } catch {
      this.threadCache.set(threadId, { at: Date.now(), ok: false, environmentId: null, updatedAt: "" });
      return false;
    }
  }

  private async latestThreadIn(environmentId: string): Promise<string | null> {
    const cached = this.envThreadCache.get(environmentId);
    if (cached && Date.now() - cached.at < THREAD_TTL_MS) return cached.threadId;
    const threads = await this.deps.sdk().threads.list({ environmentId, archived: false, limit: 50 });
    const visible = threads.filter((t) => !t.archivedAt && !t.deletedAt && t.visibility !== "hidden");
    visible.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
    const threadId = visible[0]?.id ?? null;
    if (threadId) this.threadCache.set(threadId, { at: Date.now(), ok: true, environmentId, updatedAt: String(visible[0]!.updatedAt ?? "") });
    this.envThreadCache.set(environmentId, { at: Date.now(), threadId });
    return threadId;
  }

  /** Thread activity changed which thread is most recent in an environment. */
  threadActivity(threadId: string, environmentId: string | null): void {
    if (environmentId) this.envThreadCache.delete(environmentId);
    this.threadCache.delete(threadId);
    if (this.list().some((i) => i.bindingSource === "environment" && i.environmentId === environmentId)) void this.resolve();
  }

  forgetEnvironments(): void {
    this.envCache = null;
    this.envThreadCache.clear();
  }

  async bind(key: string, threadId: string): Promise<BoundInstance> {
    const instance = this.get(key);
    if (!instance) throw new BridgeFailure("not_found", `no Helix instance ${key}`);
    if (!instance.summary.startedAt) throw new BridgeFailure("unsupported", "this instance's registry file has no start time to bind by");
    if (!(await this.threadAlive(threadId))) throw new BridgeFailure("not_found", `thread ${threadId} does not exist or is archived`);
    this.deps.store.bind(instance.hostId, instance.summary.pid, instance.summary.startedAt, threadId);
    await this.resolve();
    return this.get(key)!;
  }

  async unbind(key: string): Promise<{ removed: boolean; instance: BoundInstance }> {
    const instance = this.get(key);
    if (!instance) throw new BridgeFailure("not_found", `no Helix instance ${key}`);
    const removed = instance.summary.startedAt ? this.deps.store.unbind(instance.hostId, instance.summary.pid, instance.summary.startedAt) : false;
    await this.resolve();
    return { removed, instance: this.get(key)! };
  }

  // ----- calls ----------------------------------------------------------------

  async call<T = unknown>(key: string, method: string, params: Record<string, unknown> = {}, timeoutMs = 2500, signal?: AbortSignal): Promise<T> {
    const instance = this.get(key);
    if (!instance) throw new BridgeFailure("not_found", `no Helix instance ${key}`);
    const bridgeDir = await this.deps.bridgeDir();
    const result = (await this.deps.host.call(
      "call",
      { bridgeDir, instanceId: instance.summary.id, method, params, timeoutMs },
      { hostId: instance.hostId, timeoutMs: timeoutMs + 5000, ...(signal ? { signal } : {}) },
    )) as { ok: true; result: unknown } | { ok: false; error: BridgeCallError };
    if (!result.ok) throw new BridgeFailure(result.error.name, result.error.message, result.error.code, result.error.data);
    return result.result as T;
  }

  // ----- change notification --------------------------------------------------

  private notify(): void {
    const key = JSON.stringify(
      this.list().map((i) => [i.key, i.summary.status, i.summary.error, i.threadId, i.bindingSource, i.summary.capabilities.length, i.summary.commandPolicy, i.summary.focus?.path, i.summary.diagnostics, i.summary.mode, i.summary.lspServers, i.summary.overflows]),
    );
    if (key !== this.structureKey) {
      this.structureKey = key;
      this.deps.onChange("structure");
    } else this.deps.onChange("position");
  }
}
