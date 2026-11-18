// The file tree's server half (docs/HELIX_FILES.md): its RPC answers, every
// file system call made on the thread's host (host/files.ts) against the
// thread's own workspace, and the realtime `files-changed` that tells the tree
// to read again. Nothing here scans or watches: the signal comes from the
// tree's own operations, bb's environment changes and the end of a turn.
import type { DirListing, FileOp, FileOpResult, Sent } from "../app/files/types";
import { pathError } from "../shared/files";
import type { HelixService } from "./service";

export const FILES_CHANGED = "files-changed";
/** At most one "anything changed" per thread in this time. */
export const ANYTHING_INTERVAL_MS = 1000;

export interface FilesDeps {
  service: HelixService;
  hostCall(method: "filesList" | "filesOp" | "filesCheck", input: Record<string, unknown>, hostId: string, timeoutMs: number): Promise<unknown>;
  publish(payload: { threadId: string; dirs: string[] | null }): void;
  /** One message to the thread, queued behind a running turn. */
  send?(threadId: string, message: AgentMessage): Promise<void>;
  /** The tree read a thread's workspace. */
  read?(threadId: string, environmentId: string): void;
  log(message: string): void;
}

/** bb's own file mention: a pill in the chat over `@path` in the text, the path relative to the workspace. */
export interface PathMention {
  start: number;
  end: number;
  resource: { kind: "path"; source: "workspace"; path: string; label: string; entryKind: "file" | "directory" };
}

export interface AgentMessage {
  text: string;
  mentions: PathMention[];
}

export const ASK_MAX_PATHS = 50;
export const ASK_MAX_TEXT = 4000;

/**
 * What the tree sends the agent: only what the user asked, the paths as
 * references. A question: the paths, then the user's words. A file to write:
 * "Create @path." and the description. No instructions, no file contents.
 */
export function agentMessage(kind: "ask" | "write", entries: { path: string; kind: "file" | "dir" }[], words: string): AgentMessage {
  let text = kind === "write" ? "Create " : "";
  const mentions: PathMention[] = [];
  entries.forEach((entry, i) => {
    if (i > 0) text += " ";
    const start = text.length;
    text += `@${entry.path}`;
    mentions.push({ start, end: text.length, resource: { kind: "path", source: "workspace", path: entry.path, label: entry.path, entryKind: entry.kind === "dir" ? "directory" : "file" } });
  });
  text += kind === "write" ? `.\n\n${words}` : `\n\n${words}`;
  return { text, mentions };
}

const NO_WORKSPACE = "This thread has no workspace";

export class Files {
  /** Threads whose tree has read folders, by environment: who hears that an environment changed. */
  private readonly readers = new Map<string, Set<string>>();
  private readonly anythingSignal: Throttle;

  constructor(private readonly deps: FilesDeps) {
    this.anythingSignal = new Throttle(ANYTHING_INTERVAL_MS, (threadId) => this.deps.publish({ threadId, dirs: null }));
  }

  /** The thread's tree has read its workspace since the plugin loaded. */
  reads(threadId: string): boolean {
    for (const threads of this.readers.values()) if (threads.has(threadId)) return true;
    return false;
  }

  async list(threadId: string, dirs: string[]): Promise<{ root: string; dirs: Record<string, DirListing> }> {
    const info = await this.deps.service.threadInfo(threadId);
    if (!info.hostId || !info.path) return { root: "", dirs: Object.fromEntries(dirs.map((d) => [d, { entries: [], error: NO_WORKSPACE, truncated: false }])) };
    if (info.environmentId) {
      const set = this.readers.get(info.environmentId) ?? new Set<string>();
      set.add(threadId);
      this.readers.set(info.environmentId, set);
      this.deps.read?.(threadId, info.environmentId);
    }
    try {
      const listed = (await this.deps.hostCall("filesList", { root: info.path, dirs }, info.hostId, 15_000)) as Record<string, DirListing>;
      return { root: info.path, dirs: listed };
    } catch (error) {
      const why = `Could not read the workspace's machine: ${error instanceof Error ? error.message : String(error)}`;
      return { root: info.path, dirs: Object.fromEntries(dirs.map((d) => [d, { entries: [], error: why, truncated: false }])) };
    }
  }

  async op(threadId: string, op: FileOp): Promise<FileOpResult> {
    const info = await this.deps.service.threadInfo(threadId);
    if (!info.hostId || !info.path) return { ok: false, error: NO_WORKSPACE, paths: [] };
    let outcome: FileOpResult & { touched: string[] };
    try {
      outcome = (await this.deps.hostCall("filesOp", { root: info.path, op }, info.hostId, 120_000)) as FileOpResult & { touched: string[] };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error), paths: [] };
    }
    if (outcome.touched.length > 0) this.deps.publish({ threadId, dirs: outcome.touched });
    if (!outcome.ok) this.deps.log(`files ${op.kind} in ${threadId} failed: ${outcome.error}`);
    return { ok: outcome.ok, error: outcome.error, paths: outcome.paths };
  }

  /** Send the thread's agent a question about entries of the workspace, or ask it to write a new file. */
  async ask(threadId: string, kind: "ask" | "write", paths: string[], text: string): Promise<Sent> {
    const words = text.trim();
    if (!words) return { ok: false, error: kind === "write" ? "Say what the file should contain" : "Write what to ask" };
    if (words.length > ASK_MAX_TEXT) return { ok: false, error: `At most ${ASK_MAX_TEXT} characters` };
    if (paths.length === 0 || paths.length > ASK_MAX_PATHS) return { ok: false, error: `Between 1 and ${ASK_MAX_PATHS} entries` };
    if (kind === "write" && paths.length !== 1) return { ok: false, error: "One file at a time" };
    const unique = [...new Set(paths)];
    for (const path of unique) {
      const refused = pathError(path);
      if (refused) return { ok: false, error: refused };
    }
    const info = await this.deps.service.threadInfo(threadId);
    if (!info.hostId || !info.path) return { ok: false, error: NO_WORKSPACE };
    let checked: { kinds: ("file" | "dir")[]; error: string | null };
    try {
      checked = (await this.deps.hostCall("filesCheck", { root: info.path, paths: unique, intent: kind === "write" ? "write" : "read" }, info.hostId, 15_000)) as typeof checked;
    } catch (error) {
      return { ok: false, error: `Could not reach the workspace's machine: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (checked.error) return { ok: false, error: checked.error };
    if (!this.deps.send) return { ok: false, error: "Sending to the thread is not available" };
    try {
      await this.deps.send(threadId, agentMessage(kind, unique.map((path, i) => ({ path, kind: checked.kinds[i] ?? "file" })), words));
      return { ok: true, error: null };
    } catch (error) {
      this.deps.log(`files ${kind} to ${threadId} failed: ${String(error)}`);
      return { ok: false, error: `Could not send to the thread: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /** Open a file of the workspace in the thread's Helix, at once (the user chose it). */
  async open(threadId: string, path: string): Promise<{ ok: boolean; error: string | null }> {
    const refused = pathError(path);
    if (refused) return { ok: false, error: refused };
    const instance = (await this.deps.service.instancesForThread(threadId))[0];
    if (!instance || instance.summary.status !== "connected") return { ok: false, error: "No Helix is open for this thread" };
    try {
      await this.deps.service.show(instance, { path, interrupt: "always" });
      return { ok: true, error: null };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** bb says files in an environment changed: every tree reading it reads its open folders again. */
  environmentChanged(environmentId: string): void {
    for (const threadId of this.readers.get(environmentId) ?? []) this.anything(threadId);
  }

  /** "Anything may have changed" for a thread, at most once a second: the first at once, the rest folded into one at the end of the second. */
  anything(threadId: string): void {
    this.anythingSignal.fire(threadId);
  }

  dispose(): void {
    this.anythingSignal.dispose();
  }
}

/** A signal per thread at most once per interval: the first at once, the rest folded into one at the end of it. */
export class Throttle {
  private readonly last = new Map<string, number>();
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly intervalMs: number,
    private readonly send: (threadId: string) => void,
  ) {}

  fire(threadId: string): void {
    if (this.pending.has(threadId)) return;
    const wait = this.intervalMs - (Date.now() - (this.last.get(threadId) ?? -Infinity));
    const send = () => {
      this.pending.delete(threadId);
      this.last.set(threadId, Date.now());
      this.send(threadId);
    };
    if (wait <= 0) send();
    else this.pending.set(threadId, setTimeout(send, wait));
  }

  dispose(): void {
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }
}
