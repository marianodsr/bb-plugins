// The agent's trail in the file tree (docs/HELIX_FILES.md "The tree and the
// agent"): the files the agent changed in the running turn and in the last
// finished one. Only what the plugin already sees while it follows a turn:
// the `fileChange` items the watcher reads (watch.ts), which say add, update
// or delete, and the files Helix reloaded by itself during the turn (shell
// edits to open files, always "edited"). No reads of the repository, no git,
// nothing on a timer.
import type { AgentFile, AgentFiles } from "../app/files/types";
import { Throttle } from "./files";
import { underRoot } from "./watch";

export const AGENT_FILES = "agent-files";
/** At most four signals a second per thread. */
export const AGENT_FILES_INTERVAL_MS = 250;
const MAX_FILES = 2000;

export type Change = AgentFile["change"];

/** What a completed `fileChange` item did, by absolute path (relative ones resolve against `root`). A move is its old path deleted and its new one created. */
export function itemChanges(item: unknown, root: string | null): { path: string; change: Change }[] {
  if (typeof item !== "object" || item === null) return [];
  const record = item as { type?: unknown; status?: unknown; changes?: unknown };
  if (record.type !== "fileChange" || record.status !== "completed" || !Array.isArray(record.changes)) return [];
  const out: { path: string; change: Change }[] = [];
  for (const entry of record.changes) {
    const { path, kind, movePath, diff } = (entry ?? {}) as { path?: unknown; kind?: unknown; movePath?: unknown; diff?: unknown };
    if (typeof path !== "string" || !path) continue;
    if (typeof movePath === "string" && movePath && movePath !== path) {
      out.push({ path: underRoot(path, root), change: "deleted" }, { path: underRoot(movePath, root), change: "created" });
      continue;
    }
    // Providers that only say "update" still mark a new or removed file in the diff's header.
    const header = typeof diff === "string" ? diff.slice(0, 200) : "";
    const change: Change = kind === "add" || /^--- \/dev\/null$/mu.test(header) ? "created" : kind === "delete" || /^\+\+\+ \/dev\/null$/mu.test(header) ? "deleted" : "edited";
    out.push({ path: underRoot(path, root), change });
  }
  return out;
}

/** A later change of the same file in one turn: a file made and then removed was never there. */
function merge(before: Change | undefined, after: Change): Change | null {
  if (!before) return after;
  if (before === "created") return after === "deleted" ? null : "created";
  if (before === "deleted") return after === "deleted" ? "deleted" : "edited";
  return after === "deleted" ? "deleted" : "edited";
}

export interface TrailDeps {
  /** The thread's workspace (absolute), to make paths relative to it. */
  root(threadId: string): Promise<string | null>;
  publish(payload: { threadId: string }): void;
}

export class AgentTrail {
  /** Per thread, workspace-relative path -> change. */
  private readonly running = new Map<string, Map<string, Change>>();
  private readonly last = new Map<string, Map<string, Change>>();
  private readonly signal: Throttle;

  constructor(private readonly deps: TrailDeps) {
    this.signal = new Throttle(AGENT_FILES_INTERVAL_MS, (threadId) => this.deps.publish({ threadId }));
  }

  isRunning(threadId: string): boolean {
    return this.running.has(threadId);
  }

  /** A turn started (again "active" while running keeps what it has). */
  turnStarted(threadId: string): void {
    if (this.running.has(threadId)) return;
    this.running.set(threadId, new Map());
    this.signal.fire(threadId);
  }

  /** The turn ended: what it changed becomes the last turn's. */
  turnEnded(threadId: string): void {
    const turn = this.running.get(threadId);
    if (!turn) return;
    this.running.delete(threadId);
    this.last.set(threadId, turn);
    this.signal.fire(threadId);
  }

  /** Changes seen during the thread's running turn, by absolute path; outside the workspace they are not the tree's. */
  async note(threadId: string | null, changes: { path: string; change: Change }[]): Promise<void> {
    if (!threadId || changes.length === 0) return;
    const turn = this.running.get(threadId);
    if (!turn) return;
    const root = (await this.deps.root(threadId))?.replace(/\/$/u, "");
    if (!root) return;
    let moved = false;
    for (const { path, change } of changes) {
      const absolute = underRoot(path, root);
      if (!absolute.startsWith(`${root}/`)) continue;
      const relative = absolute.slice(root.length + 1);
      const before = turn.get(relative);
      const next = merge(before, change);
      if (next === before) continue;
      if (next === null) turn.delete(relative);
      else if (before !== undefined || turn.size < MAX_FILES) turn.set(relative, next);
      else continue;
      moved = true;
    }
    if (moved) this.signal.fire(threadId);
  }

  files(threadId: string): AgentFiles {
    const turn = this.running.get(threadId);
    const files: AgentFile[] = [...(turn ?? new Map<string, Change>())].map(([path, change]) => ({ path, change, turn: "running" }));
    for (const [path, change] of this.last.get(threadId) ?? []) if (!turn?.has(path)) files.push({ path, change, turn: "last" });
    return { running: turn !== undefined, files };
  }

  dispose(): void {
    this.signal.dispose();
  }
}
