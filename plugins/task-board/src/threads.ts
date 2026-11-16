// Linked-thread status, read from bb on demand. The board keeps no copy of a
// thread's state: `statuses` asks bb (one batched list call per 200 threads)
// and the watcher only tells open readers when to ask again.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ThreadState, ThreadStatusView } from "./schemas.js";

type ListedThread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["list"]>>[number];

const BATCH = 200;

export function threadTag(threadId: string): string {
  return `thread:${threadId}`;
}

export function stateOf(thread: Pick<ListedThread, "archivedAt" | "hasPendingInteraction" | "status" | "runtime">): ThreadState {
  if (thread.archivedAt !== null) return "archived";
  if (thread.hasPendingInteraction) return "waiting";
  switch (thread.runtime.displayStatus) {
    case "active":
    case "starting":
    case "stopping":
    case "provisioning":
    case "waiting-for-host":
      return "running";
    case "error":
      return "failed";
    default:
      return thread.status === "error" ? "failed" : "idle";
  }
}

function view(thread: ListedThread): ThreadStatusView {
  return {
    threadId: thread.id,
    state: stateOf(thread),
    title: thread.title ?? thread.titleFallback ?? null,
    projectId: thread.projectId,
    status: thread.status,
    displayStatus: thread.runtime.displayStatus,
    hasPendingInteraction: thread.hasPendingInteraction,
    archivedAt: thread.archivedAt,
    updatedAt: thread.updatedAt,
  };
}

export function missing(threadId: string): ThreadStatusView {
  return {
    threadId,
    state: "missing",
    title: null,
    projectId: null,
    status: null,
    displayStatus: null,
    hasPendingInteraction: false,
    archivedAt: null,
    updatedAt: null,
  };
}

/** Current status for each id; unknown or deleted threads are "missing". */
export async function readStatuses(
  bb: BbPluginApi,
  threadIds: readonly string[],
  signal?: AbortSignal,
): Promise<Record<string, ThreadStatusView>> {
  const unique = [...new Set(threadIds)];
  const result: Record<string, ThreadStatusView> = {};
  for (let start = 0; start < unique.length; start += BATCH) {
    const batch = unique.slice(start, start + BATCH);
    const found = new Map<string, ListedThread>();
    for (const thread of await bb.sdk.threads.list({
      threadIds: batch,
      includeHidden: true,
      limit: batch.length,
      ...(signal ? { signal } : {}),
    })) {
      found.set(thread.id, thread);
    }
    // Archived threads are listed only when asked for; ask for the rest once.
    const rest = batch.filter((id) => !found.has(id));
    if (rest.length > 0) {
      for (const thread of await bb.sdk.threads.list({
        threadIds: rest,
        includeHidden: true,
        archived: true,
        limit: rest.length,
        ...(signal ? { signal } : {}),
      })) {
        found.set(thread.id, thread);
      }
    }
    for (const id of batch) {
      const thread = found.get(id);
      result[id] = thread ? view(thread) : missing(id);
    }
  }
  return result;
}

/** Thread changes that can alter what a card shows. */
const RELEVANT_CHANGES = new Set([
  "status-changed",
  "interactions-changed",
  "archived-changed",
  "title-changed",
  "thread-deleted",
]);

/**
 * Watch bb's thread change stream and invalidate `thread:<id>` for linked
 * threads only. Each message costs one set lookup; streaming output
 * ("events-appended") is ignored. Invalidations are coalesced per tick.
 */
export class ThreadWatcher {
  private linked = new Set<string>();
  private pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: Array<() => void> = [];

  constructor(
    private readonly bb: BbPluginApi,
    private readonly invalidate: (tags: string[]) => void,
    private readonly coalesceMs = 50,
  ) {}

  setLinked(threadIds: Iterable<string>): void {
    this.linked = new Set(threadIds);
  }

  add(threadId: string): void {
    this.linked.add(threadId);
  }

  remove(threadId: string): void {
    this.linked.delete(threadId);
  }

  isLinked(threadId: string): boolean {
    return this.linked.has(threadId);
  }

  start(): void {
    this.unsubscribe.push(
      this.bb.sdk.subscribe({
        event: "thread:changed",
        callback: (message) => {
          const id = message.id;
          if (id === undefined || !this.linked.has(id)) return;
          if (!message.changes.some((change) => RELEVANT_CHANGES.has(change))) return;
          this.schedule(id);
        },
      }),
      this.bb.sdk.subscribe({
        event: "realtime:connection",
        callback: (event) => {
          // Changes during a disconnect were missed: refresh every linked thread.
          if (event.state === "connected" && event.reconnected) {
            for (const id of this.linked) this.schedule(id);
          }
        },
      }),
    );
  }

  /** Mark one linked thread for refresh (used by lifecycle events too). */
  schedule(threadId: string): void {
    this.pending.add(threadId);
    if (this.timer !== null) return;
    this.timer = setTimeout(() => this.flush(), this.coalesceMs);
  }

  flush(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.pending.size === 0) return;
    const tags = [...this.pending].map(threadTag);
    this.pending.clear();
    this.invalidate(tags);
  }

  stop(): void {
    for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
  }
}
