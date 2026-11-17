// Watching the agent write. While a turn runs in an environment that a
// connected Helix serves, follow that thread's `item/completed` events with a
// long-poll (`threads.events.wait`), and the moment a file edit completes,
// reload exactly those files in Helix with `reveal` (shown as if typed) and,
// when "Follow the agent" is on, `follow` (the view moves there; Helix defers
// it while the user types).
//
// Granularity: one edit. bb records an edit as a `fileChange` item when the
// tool has written it; no provider streams the patch text while the model
// generates it (Codex's `item/fileChange/outputDelta` is the patch tool's
// result text). The end-of-turn `changes` list (follow.ts) is unchanged.
import { isAbsolute, join, normalize } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { BoundInstance } from "./bridge";
import type { HelixService } from "./service";

type Sdk = BbPluginApi["sdk"];

const WAIT_MS = 20_000;

interface EventRow {
  seq: number | string;
  createdAt?: number;
  data?: { item?: unknown };
}

export interface FileEdit {
  threadId: string;
  environmentId: string;
  paths: string[];
  /** When bb recorded the edit (ms). */
  at: number;
}

/** The files a completed `fileChange` item wrote, absolute (relative ones resolve against `root`). */
export function editedPaths(item: unknown, root: string | null): string[] | null {
  if (typeof item !== "object" || item === null) return null;
  const record = item as { type?: unknown; status?: unknown; changes?: unknown };
  if (record.type !== "fileChange" || record.status !== "completed" || !Array.isArray(record.changes)) return null;
  const paths = new Set<string>();
  for (const change of record.changes) {
    const path = (change as { path?: unknown; kind?: unknown })?.path;
    if (typeof path !== "string" || !path) continue;
    if ((change as { kind?: unknown }).kind === "delete") continue;
    paths.add(isAbsolute(path) ? normalize(path) : root ? normalize(join(root, path)) : path);
  }
  return paths.size > 0 ? [...paths] : null;
}

export interface WatchDeps {
  sdk(): Sdk;
  service: HelixService;
  settings(): Promise<{ autoReload: boolean; followAgent: boolean }>;
  log(message: string): void;
  /** For measurement: how long from bb recording an edit to Helix having it. */
  timing?(edit: FileEdit, ms: number, instance: BoundInstance): void;
}

export class AgentWatcher {
  private readonly loops = new Map<string, AbortController>();

  constructor(private readonly deps: WatchDeps) {}

  /** Environments with a watcher running (an agent turn there). */
  watching(environmentId: string): boolean {
    for (const [, c] of this.loops) if ((c as AbortController & { environmentId?: string }).environmentId === environmentId) return true;
    return false;
  }

  /** A turn started: follow its edits if a connected Helix serves its environment. */
  start(threadId: string, environmentId: string | null): void {
    if (!environmentId || this.loops.has(threadId)) return;
    if (!this.serving(environmentId).some((i) => i.summary.capabilities.includes("reload"))) return;
    const controller = Object.assign(new AbortController(), { environmentId });
    this.loops.set(threadId, controller);
    void this.loop(threadId, environmentId, controller.signal).finally(() => {
      if (this.loops.get(threadId) === controller) this.loops.delete(threadId);
    });
  }

  /** The turn ended: stop following. */
  stop(threadId: string): void {
    this.loops.get(threadId)?.abort();
    this.loops.delete(threadId);
  }

  dispose(): void {
    for (const controller of this.loops.values()) controller.abort();
    this.loops.clear();
  }

  private serving(environmentId: string): BoundInstance[] {
    return this.deps.service.bridge.list().filter((i) => i.summary.status === "connected" && i.environmentId === environmentId);
  }

  private async loop(threadId: string, environmentId: string, signal: AbortSignal): Promise<void> {
    const sdk = this.deps.sdk();
    let afterSeq: string | undefined;
    try {
      const latest = await sdk.threads.events.list({ threadId, order: "desc", limit: "1", signal });
      const rows = (Array.isArray(latest) ? latest : ((latest as { events?: unknown[] }).events ?? [])) as { seq: number | string }[];
      if (rows[0]) afterSeq = String(rows[0].seq);
    } catch {
      // start from the next event
    }
    const root = (await this.deps.service.threadInfo(threadId)).path;
    while (!signal.aborted) {
      let row: EventRow | null;
      try {
        row = (await sdk.threads.events.wait({ threadId, type: "item/completed", waitMs: String(WAIT_MS), ...(afterSeq ? { afterSeq } : {}), signal })) as unknown as EventRow | null;
      } catch (error) {
        if (signal.aborted) return;
        this.deps.log(`watching ${threadId} failed: ${String(error)}`);
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      if (!row) continue;
      afterSeq = String(row.seq);
      const paths = editedPaths(row.data?.item, root);
      if (!paths) continue;
      await this.onEdit({ threadId, environmentId, paths, at: typeof row.createdAt === "number" ? row.createdAt : Date.now() });
    }
  }

  /** Reload exactly the edited files in every Helix serving the environment. */
  async onEdit(edit: FileEdit): Promise<void> {
    this.deps.service.noteAgentEdit(edit.environmentId);
    const settings = await this.deps.settings();
    if (!settings.autoReload) return;
    for (const instance of this.serving(edit.environmentId)) {
      const caps = new Set(instance.summary.capabilities);
      if (!caps.has("reload")) continue;
      const reveal = caps.has("reveal");
      try {
        await this.deps.service.bridge.call(instance.key, "editor/reload", {
          paths: edit.paths,
          ...(reveal ? { reveal: true } : {}),
          ...(reveal && settings.followAgent ? { follow: true, interrupt: "whenIdle" } : {}),
        });
        this.deps.timing?.(edit, Date.now() - edit.at, instance);
      } catch (error) {
        this.deps.log(`reload after an agent edit on ${instance.key} failed: ${String(error)}`);
      }
    }
  }
}
