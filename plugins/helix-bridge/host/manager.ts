// Finds the Helix instances on this machine and keeps one connection to each.
//
// The registry directory (`<cache>/bridge/*.json`) is watched and rescanned;
// a file whose socket refuses and whose process is gone is stale and removed.
// Each instance's state is folded from its events in memory (O(1) per event),
// and the server hears about it through one coalesced `state` signal, so a
// burst of selection events costs a few signals per second at most. `:bb-*`
// sends are queued until the server acknowledges them.
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { InstanceSummary, SendRecord } from "../shared/host-contract";
import {
  CLIENT_NAME,
  EVENT_KINDS,
  PROTOCOL_VERSION,
  type EditorState,
  type HelloResult,
  type Range,
  type RegistryFile,
} from "../shared/protocol";
import { BridgeConnection, RpcError, type RpcFailure } from "./connection";

export const CLIENT_VERSION = "0.1.0";
const HELLO_TIMEOUT_MS = 3000;
const EDITOR_TIMEOUT_MS = 2500;
const SIGNAL_INTERVAL_MS = 150;
const RESCAN_INTERVAL_MS = 5000;
const DIR_POLL_MS = 2000;
const MAX_SENDS = 200;
const MAX_EXTERNAL = 20;

/** Helix's cache directory rules: `$XDG_CACHE_HOME/helix`, else `~/.cache/helix`. */
export function defaultBridgeDir(env: NodeJS.ProcessEnv = process.env): string {
  const cache = env.XDG_CACHE_HOME && env.XDG_CACHE_HOME.startsWith("/") ? env.XDG_CACHE_HOME : join(env.HOME || homedir(), ".cache");
  return join(cache, "helix", "bridge");
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface ManagerDeps {
  /** Publish every instance's summary to the server. */
  emitState(payload: { bridgeDir: string; instances: InstanceSummary[] }): void;
  /** Keep the worker alive; returns a release function. */
  retain(): () => void;
  /** Watch a directory; returns a disposer. Optional (tests poll). */
  watch?(dir: string, onChange: () => void): Promise<() => void>;
  log?(message: string): void;
}

interface Instance {
  id: string;
  registryPath: string;
  registry: RegistryFile;
  connection: BridgeConnection | null;
  summary: InstanceSummary;
  documents: Map<number, { path: string | null; languageId: string; modified: boolean }>;
  diagByPath: Map<string, { errors: number; warnings: number }>;
  diagTimer: ReturnType<typeof setTimeout> | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  attempts: number;
  removed: boolean;
}

export class InstanceManager {
  readonly bridgeDir: string;
  private readonly instances = new Map<string, Instance>();
  private readonly sends: SendRecord[] = [];
  private sendSeq = 0;
  private signalTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSignalAt = 0;
  private rescanTimer: ReturnType<typeof setInterval> | null = null;
  private unwatch: (() => void) | null = null;
  private release: (() => void) | null = null;
  private disposed = false;

  constructor(
    bridgeDir: string,
    private readonly deps: ManagerDeps,
  ) {
    this.bridgeDir = bridgeDir;
  }

  start(): void {
    this.scan();
    void this.startWatching();
    this.rescanTimer = setInterval(() => this.scan(), RESCAN_INTERVAL_MS);
  }

  get dirExists(): boolean {
    try {
      return statSync(this.bridgeDir).isDirectory();
    } catch {
      return false;
    }
  }

  private async startWatching(): Promise<void> {
    if (!this.deps.watch || this.disposed) return;
    if (!this.dirExists) {
      // Helix creates the directory on first start; look again shortly.
      setTimeout(() => void this.startWatching(), DIR_POLL_MS);
      return;
    }
    try {
      const dispose = await this.deps.watch(this.bridgeDir, () => this.scan());
      if (this.disposed) dispose();
      else this.unwatch = dispose;
    } catch (error) {
      this.deps.log?.(`watching ${this.bridgeDir} failed: ${String(error)}; rescanning every ${RESCAN_INTERVAL_MS} ms`);
    }
  }

  /** Read the registry directory and reconcile instances with it. */
  scan(): void {
    if (this.disposed) return;
    let names: string[] = [];
    try {
      names = readdirSync(this.bridgeDir).filter((name) => name.endsWith(".json"));
    } catch {
      names = [];
    }
    const seen = new Set<string>();
    for (const name of names) {
      const path = join(this.bridgeDir, name);
      const registry = readRegistry(path);
      if (!registry) continue;
      const id = String(registry.pid);
      seen.add(id);
      const existing = this.instances.get(id);
      if (existing && existing.registry.startedAt === registry.startedAt && existing.registry.socket === registry.socket) continue;
      if (existing) this.drop(existing, false);
      this.add(id, path, registry);
    }
    for (const instance of [...this.instances.values()]) if (!seen.has(instance.id)) this.drop(instance, false);
  }

  private add(id: string, registryPath: string, registry: RegistryFile): void {
    const instance: Instance = {
      id,
      registryPath,
      registry,
      connection: null,
      summary: emptySummary(id, registry),
      documents: new Map(),
      diagByPath: new Map(),
      diagTimer: null,
      retryTimer: null,
      attempts: 0,
      removed: false,
    };
    this.instances.set(id, instance);
    this.deps.log?.(`instance ${id} found (${registry.workspaceRoot ?? registry.cwd ?? "?"})`);
    void this.connect(instance);
    this.changed();
  }

  private drop(instance: Instance, deleteFiles: boolean): void {
    instance.removed = true;
    if (instance.retryTimer) clearTimeout(instance.retryTimer);
    if (instance.diagTimer) clearTimeout(instance.diagTimer);
    instance.connection?.close();
    this.instances.delete(instance.id);
    if (deleteFiles) {
      for (const path of [instance.registryPath, instance.registry.socket]) {
        try {
          if (existsSync(path)) unlinkSync(path);
        } catch {
          // another client may have removed it first
        }
      }
      this.deps.log?.(`instance ${instance.id} was stale; removed its registry file and socket`);
    } else this.deps.log?.(`instance ${instance.id} left`);
    this.updateLease();
    this.changed();
  }

  private async connect(instance: Instance): Promise<void> {
    if (instance.removed || this.disposed) return;
    instance.summary.status = "connecting";
    const connection = new BridgeConnection(instance.registry.socket, {
      onNotification: (method, params) => this.onEvent(instance, method, params),
      onClose: (error) => {
        if (instance.connection !== connection) return;
        instance.connection = null;
        if (instance.removed || this.disposed) return;
        instance.summary.status = "disconnected";
        instance.summary.error = error ? error.message : "the editor closed the connection";
        this.updateLease();
        this.changed();
        this.retry(instance);
      },
    });
    try {
      await connection.connect();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!pidAlive(instance.registry.pid)) {
        this.drop(instance, true);
        return;
      }
      instance.summary.status = "disconnected";
      instance.summary.error = `cannot connect (${code ?? String(error)})`;
      this.changed();
      this.retry(instance);
      return;
    }
    if (instance.removed || this.disposed) {
      connection.close();
      return;
    }
    instance.connection = connection;
    try {
      const hello = (await connection.request("bridge/hello", { client: CLIENT_NAME, clientVersion: CLIENT_VERSION }, HELLO_TIMEOUT_MS)) as HelloResult;
      instance.summary.protocol = hello.protocol;
      instance.summary.helixVersion = hello.helixVersion ?? instance.summary.helixVersion;
      instance.summary.capabilities = Array.isArray(hello.capabilities) ? hello.capabilities.filter((c) => typeof c === "string") : [];
      instance.summary.commandPolicy = hello.commandPolicy ?? null;
      if (hello.cwd) instance.summary.cwd = hello.cwd;
      if (hello.workspaceRoot) instance.summary.workspaceRoot = hello.workspaceRoot;
      if (hello.protocol !== PROTOCOL_VERSION) {
        instance.summary.status = "incompatible";
        instance.summary.error = `Helix speaks bridge protocol ${hello.protocol}; this plugin speaks ${PROTOCOL_VERSION}`;
        instance.connection = null; // not a drop to recover from: no retry
        connection.close();
        this.changed();
        return;
      }
      await connection.request("events/subscribe", { events: [...EVENT_KINDS] }, EDITOR_TIMEOUT_MS);
      instance.attempts = 0;
      instance.summary.status = "connected";
      instance.summary.error = null;
      this.updateLease();
      this.changed();
      await this.resync(instance);
    } catch (error) {
      instance.summary.error = error instanceof Error ? error.message : String(error);
      connection.close();
    }
  }

  private retry(instance: Instance): void {
    if (instance.removed || this.disposed || instance.retryTimer) return;
    instance.attempts += 1;
    const delay = Math.min(5000, 250 * 2 ** Math.min(instance.attempts - 1, 5));
    instance.retryTimer = setTimeout(() => {
      instance.retryTimer = null;
      if (!existsSync(instance.registryPath)) {
        this.drop(instance, false);
        return;
      }
      void this.connect(instance);
    }, delay);
  }

  /** Re-read focus, documents, mode and diagnostics (after connect or overflow). */
  private async resync(instance: Instance): Promise<void> {
    const connection = instance.connection;
    if (!connection) return;
    const caps = new Set(instance.summary.capabilities);
    try {
      if (caps.has("editor")) {
        const state = (await connection.request("editor/state", {}, EDITOR_TIMEOUT_MS)) as EditorState;
        instance.documents.clear();
        for (const doc of state.documents ?? []) instance.documents.set(doc.docId, { path: doc.path, languageId: doc.languageId, modified: doc.modified });
        instance.summary.documents = instance.documents.size;
        instance.summary.mode = state.mode;
        const focused = state.focused;
        if (focused) {
          const primary = focused.selections?.[focused.primary ?? 0];
          instance.summary.focus = {
            path: focused.path,
            docId: focused.docId,
            languageId: focused.languageId ?? null,
            modified: Boolean(focused.modified),
            ...cursorOf(primary),
            selections: focused.selections?.length ?? 0,
          };
        }
      }
      if (caps.has("diagnostics")) await this.refreshDiagnostics(instance);
      this.changed();
    } catch (error) {
      this.deps.log?.(`resync of ${instance.id} failed: ${String(error)}`);
    }
  }

  private async refreshDiagnostics(instance: Instance): Promise<void> {
    const connection = instance.connection;
    if (!connection) return;
    const errors = (await connection.request("diagnostics/get", { minSeverity: "error", limit: 1 }, EDITOR_TIMEOUT_MS)) as { total: number };
    const both = (await connection.request("diagnostics/get", { minSeverity: "warning", limit: 1 }, EDITOR_TIMEOUT_MS)) as { total: number };
    instance.summary.diagnostics = { errors: errors.total ?? 0, warnings: Math.max(0, (both.total ?? 0) - (errors.total ?? 0)) };
  }

  private onEvent(instance: Instance, method: string, raw: unknown): void {
    const params = (raw ?? {}) as Record<string, unknown>;
    const summary = instance.summary;
    summary.events += 1;
    switch (method) {
      case "event/selection": {
        const ranges = params.ranges as Range[] | undefined;
        const primary = ranges?.[Number(params.primary ?? 0)];
        const docId = Number(params.docId);
        const doc = instance.documents.get(docId);
        summary.focus = {
          path: (params.path as string | null) ?? null,
          docId,
          languageId: doc?.languageId ?? summary.focus?.languageId ?? null,
          modified: doc?.modified ?? false,
          ...cursorOf(primary),
          selections: ranges?.length ?? 0,
        };
        break;
      }
      case "event/focus": {
        const docId = Number(params.docId);
        const doc = instance.documents.get(docId);
        summary.focus = { path: (params.path as string | null) ?? null, docId, languageId: doc?.languageId ?? null, modified: doc?.modified ?? false, cursor: null, anchor: null, selections: 0 };
        break;
      }
      case "event/documentOpened":
        instance.documents.set(Number(params.docId), { path: (params.path as string) ?? null, languageId: String(params.languageId ?? ""), modified: false });
        summary.documents = instance.documents.size;
        break;
      case "event/documentClosed":
        instance.documents.delete(Number(params.docId));
        summary.documents = instance.documents.size;
        break;
      case "event/documentChanged":
      case "event/documentSaved": {
        const doc = instance.documents.get(Number(params.docId));
        const modified = method === "event/documentSaved" ? false : Boolean(params.modified);
        if (doc) doc.modified = modified;
        if (summary.focus && summary.focus.docId === Number(params.docId)) {
          if (summary.focus.modified === modified) return; // nothing the server shows changed
          summary.focus.modified = modified;
        } else return;
        break;
      }
      case "event/diagnostics": {
        const path = String(params.path ?? "");
        instance.diagByPath.set(path, { errors: Number(params.errors ?? 0), warnings: Number(params.warnings ?? 0) });
        if (summary.capabilities.includes("diagnostics")) {
          if (!instance.diagTimer)
            instance.diagTimer = setTimeout(() => {
              instance.diagTimer = null;
              void this.refreshDiagnostics(instance).then(() => this.changed(), () => {});
            }, 300);
          return;
        }
        let errors = 0;
        let warnings = 0;
        for (const counts of instance.diagByPath.values()) {
          errors += counts.errors;
          warnings += counts.warnings;
        }
        summary.diagnostics = { errors, warnings };
        break;
      }
      case "event/mode":
        summary.mode = String(params.mode ?? "");
        break;
      case "event/send": {
        this.sendSeq += 1;
        this.sends.push({ id: `${instance.id}:${Date.now()}:${this.sendSeq}`, instanceId: instance.id, receivedAt: Date.now(), event: params });
        if (this.sends.length > MAX_SENDS) this.sends.splice(0, this.sends.length - MAX_SENDS);
        this.syncSendCounts();
        this.changed(true);
        return;
      }
      case "event/lsp": {
        const name = String(params.name ?? params.id ?? "?");
        const set = new Set(summary.lspServers);
        if (params.state === "exited") set.delete(name);
        else set.add(name);
        summary.lspServers = [...set];
        break;
      }
      case "event/externalChange":
        summary.externalChanges = [String(params.path ?? ""), ...summary.externalChanges.filter((p) => p !== params.path)].slice(0, MAX_EXTERNAL);
        break;
      case "event/overflow":
        summary.overflows += 1;
        summary.dropped += Number(params.dropped ?? 0);
        void this.resync(instance);
        break;
      default:
        return;
    }
    this.changed();
  }

  private syncSendCounts(): void {
    for (const instance of this.instances.values()) instance.summary.pendingSends = this.sends.filter((s) => s.instanceId === instance.id).length;
  }

  /** Coalesce state signals: at most one per SIGNAL_INTERVAL_MS, trailing. */
  private changed(urgent = false): void {
    if (this.disposed) return;
    for (const instance of this.instances.values()) instance.summary.updatedAt = Date.now();
    if (this.signalTimer && !urgent) return;
    if (this.signalTimer) clearTimeout(this.signalTimer);
    const wait = urgent ? 0 : Math.max(0, SIGNAL_INTERVAL_MS - (Date.now() - this.lastSignalAt));
    this.signalTimer = setTimeout(() => {
      this.signalTimer = null;
      this.lastSignalAt = Date.now();
      this.deps.emitState({ bridgeDir: this.bridgeDir, instances: this.list() });
    }, wait);
  }

  private updateLease(): void {
    const connected = [...this.instances.values()].some((i) => i.connection?.connected);
    if (connected && !this.release) this.release = this.deps.retain();
    else if (!connected && this.release) {
      this.release();
      this.release = null;
    }
  }

  list(): InstanceSummary[] {
    return [...this.instances.values()].map((i) => structuredClone(i.summary)).sort((a, b) => a.pid - b.pid);
  }

  async call(instanceId: string, method: string, params: Record<string, unknown> | undefined, timeoutMs: number, signal?: AbortSignal): Promise<{ ok: true; result: unknown } | { ok: false; error: RpcFailure }> {
    const instance = this.instances.get(instanceId);
    if (!instance) return { ok: false, error: { code: 0, name: "not_found", message: `no Helix instance ${instanceId} on this machine` } };
    if (!instance.connection?.connected) return { ok: false, error: { code: 0, name: "not_connected", message: `Helix ${instanceId} is ${instance.summary.status}${instance.summary.error ? `: ${instance.summary.error}` : ""}` } };
    try {
      return { ok: true, result: await instance.connection.request(method, params ?? {}, timeoutMs, signal) };
    } catch (error) {
      if (error instanceof RpcError) return { ok: false, error: error.failure };
      return { ok: false, error: { code: 0, name: "transport", message: String(error) } };
    }
  }

  pendingSends(): SendRecord[] {
    return this.sends.map((s) => structuredClone(s));
  }

  ackSends(ids: readonly string[]): number {
    const drop = new Set(ids);
    for (let i = this.sends.length - 1; i >= 0; i -= 1) if (drop.has(this.sends[i]!.id)) this.sends.splice(i, 1);
    this.syncSendCounts();
    this.changed();
    return this.sends.length;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.rescanTimer) clearInterval(this.rescanTimer);
    if (this.signalTimer) clearTimeout(this.signalTimer);
    this.unwatch?.();
    for (const instance of this.instances.values()) {
      instance.removed = true;
      if (instance.retryTimer) clearTimeout(instance.retryTimer);
      if (instance.diagTimer) clearTimeout(instance.diagTimer);
      instance.connection?.close();
    }
    this.instances.clear();
    this.release?.();
    this.release = null;
  }
}

function cursorOf(range: Range | undefined): { cursor: { line: number; col: number } | null; anchor: { line: number; col: number } | null } {
  if (!range?.start) return { cursor: null, anchor: null };
  const extent = range.end && (range.end.line !== range.start.line || range.end.col !== range.start.col);
  return { cursor: { line: range.start.line, col: range.start.col }, anchor: extent ? { line: range.end.line, col: range.end.col } : null };
}

export function readRegistry(path: string): RegistryFile | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<RegistryFile>;
    if (typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || typeof value.socket !== "string" || !value.socket.startsWith("/")) return null;
    return value as RegistryFile;
  } catch {
    return null; // half-written or not ours
  }
}

function emptySummary(id: string, registry: RegistryFile): InstanceSummary {
  const env: Record<string, string> = {};
  for (const key of ["BB_THREAD_ID", "BB_ENVIRONMENT_ID", "BB_PROJECT_ID", "BB_TERMINAL_ID"] as const) {
    const value = registry.env?.[key];
    if (typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/u.test(value)) env[key] = value;
  }
  return {
    id,
    pid: registry.pid,
    socket: registry.socket,
    helixVersion: registry.helixVersion ?? null,
    startedAt: registry.startedAt ?? null,
    cwd: registry.cwd ?? null,
    workspaceRoot: registry.workspaceRoot ?? null,
    env,
    status: "connecting",
    protocol: registry.protocol ?? null,
    capabilities: [],
    commandPolicy: null,
    error: null,
    mode: null,
    focus: null,
    diagnostics: { errors: 0, warnings: 0 },
    documents: 0,
    lspServers: [],
    externalChanges: [],
    pendingSends: 0,
    overflows: 0,
    dropped: 0,
    events: 0,
    updatedAt: Date.now(),
  };
}
