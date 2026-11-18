// The file tree's server half (docs/HELIX_FILES.md): its RPC answers, every
// file system call made on the thread's host (host/files.ts) against the
// thread's own workspace, and the realtime `files-changed` that tells the tree
// to read again. Nothing here scans or watches: the signal comes from the
// tree's own operations, bb's environment changes and the end of a turn.
import type { DirListing, FileOp, FileOpResult } from "../app/files/types";
import { pathError } from "../shared/files";
import type { HelixService } from "./service";

export const FILES_CHANGED = "files-changed";
/** At most one "anything changed" per thread in this time. */
export const ANYTHING_INTERVAL_MS = 1000;

export interface FilesDeps {
  service: HelixService;
  hostCall(method: "filesList" | "filesOp", input: Record<string, unknown>, hostId: string, timeoutMs: number): Promise<unknown>;
  publish(payload: { threadId: string; dirs: string[] | null }): void;
  log(message: string): void;
}

const NO_WORKSPACE = "This thread has no workspace";

export class Files {
  /** Threads whose tree has read folders, by environment: who hears that an environment changed. */
  private readonly readers = new Map<string, Set<string>>();
  private readonly lastAnything = new Map<string, number>();
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly deps: FilesDeps) {}

  async list(threadId: string, dirs: string[]): Promise<{ root: string; dirs: Record<string, DirListing> }> {
    const info = await this.deps.service.threadInfo(threadId);
    if (!info.hostId || !info.path) return { root: "", dirs: Object.fromEntries(dirs.map((d) => [d, { entries: [], error: NO_WORKSPACE, truncated: false }])) };
    if (info.environmentId) {
      const set = this.readers.get(info.environmentId) ?? new Set<string>();
      set.add(threadId);
      this.readers.set(info.environmentId, set);
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
    if (this.pending.has(threadId)) return;
    const wait = ANYTHING_INTERVAL_MS - (Date.now() - (this.lastAnything.get(threadId) ?? 0));
    const send = () => {
      this.pending.delete(threadId);
      this.lastAnything.set(threadId, Date.now());
      this.deps.publish({ threadId, dirs: null });
    };
    if (wait <= 0) send();
    else this.pending.set(threadId, setTimeout(send, wait));
  }

  dispose(): void {
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }
}
