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
  /** Absolute path -> the item's diff for it (`-`/`+` lines, no line numbers). */
  diffs?: Map<string, string>;
  /** When bb recorded the edit (ms). */
  at: number;
}

/**
 * An edited path as Helix knows it. Agents may report the resolved path
 * (`/private/tmp/...` on macOS) while Helix and bb use the environment's own
 * (`/tmp/...`), and Helix treats the two as different buffers.
 */
export function underRoot(path: string, root: string | null): string {
  const absolute = isAbsolute(path) ? normalize(path) : root ? normalize(join(root, path)) : path;
  if (!root || absolute.startsWith(`${root}/`)) return absolute;
  if (absolute.startsWith(`/private${root}/`)) return absolute.slice("/private".length);
  if (root.startsWith("/private/") && absolute.startsWith(`${root.slice("/private".length)}/`)) return `/private${absolute}`;
  return absolute;
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
    paths.add(underRoot(path, root));
  }
  return paths.size > 0 ? [...paths] : null;
}

/** The diff of each file a completed `fileChange` item wrote, by absolute path. */
export function editedDiffs(item: unknown, root: string | null): Map<string, string> {
  const out = new Map<string, string>();
  const changes = (item as { changes?: unknown })?.changes;
  if (!Array.isArray(changes)) return out;
  for (const change of changes) {
    const { path, kind, diff } = (change ?? {}) as { path?: unknown; kind?: unknown; diff?: unknown };
    if (typeof path !== "string" || !path || kind === "delete" || typeof diff !== "string") continue;
    out.set(underRoot(path, root), diff);
  }
  return out;
}

interface Range {
  start: { line: number; col: number };
  end: { line: number; col: number };
}

/**
 * Where a diff's added text sits in the file now, for `editor/reveal`. The
 * diffs bb records carry `-`/`+` lines without line numbers, so the first
 * block of added lines is looked up in the current text (the whole file, up
 * to 200 lines, for a new one). Null when it cannot be found.
 */
export function revealOf(diff: string, text: string): { ranges: Range[]; removed: { line: number; text: string }[] } | null {
  const body = diff.split("\n").filter((l) => !l.startsWith("--- ") && !l.startsWith("+++ "));
  const added: string[] = [];
  const removed: string[] = [];
  for (const line of body) {
    if (line.startsWith("+")) added.push(line.slice(1));
    else if (line.startsWith("-") && added.length === 0) removed.push(line.slice(1));
    else if (added.length > 0) break;
  }
  const lines = text.split("\n");
  if (added.length === 0) return null;
  if (/^--- \/dev\/null/mu.test(diff)) {
    const last = Math.min(lines.length, 200);
    return { ranges: [{ start: { line: 1, col: 1 }, end: { line: last + 1, col: 1 } }], removed: [] };
  }
  for (let i = 0; i + added.length <= lines.length; i += 1) {
    if (added.every((a, j) => lines[i + j] === a)) {
      const start = i + 1;
      return {
        ranges: [{ start: { line: start, col: 1 }, end: { line: start + added.length, col: 1 } }],
        removed: removed.length > 0 ? [{ line: start, text: removed.join("\n") }] : [],
      };
    }
  }
  return null;
}

/**
 * Every changed block of a diff as places in the file's current text: runs of
 * `-`/`+` lines, located by their added lines (searched in order, so blocks
 * keep their sequence). A block with nothing added cannot be placed. A new
 * file is one place over its first lines.
 */
export function placesOf(diff: string, text: string): { line: number; endLine?: number; label: string }[] {
  const lines = text.split("\n");
  if (/^--- \/dev\/null/mu.test(diff)) {
    const count = Math.max(1, lines.length - (text.endsWith("\n") ? 1 : 0));
    return [{ line: 1, ...(count > 1 ? { endLine: count } : {}), label: `+${count} new file` }];
  }
  const blocks: { added: string[]; removed: number }[] = [];
  let current: { added: string[]; removed: number } | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("--- ") || line.startsWith("+++ ")) continue;
    if (line.startsWith("+") || line.startsWith("-")) {
      current ??= { added: [], removed: 0 };
      if (line.startsWith("+")) current.added.push(line.slice(1));
      else current.removed += 1;
    } else if (current) {
      blocks.push(current);
      current = null;
    }
  }
  if (current) blocks.push(current);
  // An edit tool's diff holds its old and new strings, which can start or end
  // inside a line: the first added line then ends a line of the file and the
  // last one starts a line. Whole lines are tried first.
  const exact = (added: string[], i: number) => added.every((a, j) => lines[i + j] === a);
  const partial = (added: string[], i: number) =>
    added.some((a) => a.trim() !== "") &&
    added.every((a, j) => {
      const line = lines[i + j]!;
      if (added.length === 1) return line.includes(a);
      if (j === 0) return line.endsWith(a);
      if (j === added.length - 1) return line.startsWith(a);
      return line === a;
    });
  const places: { line: number; endLine?: number; label: string }[] = [];
  let from = 0;
  for (const block of blocks) {
    if (block.added.length === 0) continue;
    for (const matches of [exact, partial]) {
      let found = -1;
      for (let i = from; i + block.added.length <= lines.length; i += 1)
        if (matches(block.added, i)) {
          found = i;
          break;
        }
      if (found < 0) continue;
      const line = found + 1;
      places.push({ line, ...(block.added.length > 1 ? { endLine: line + block.added.length - 1 } : {}), label: `+${block.added.length} -${block.removed}` });
      from = found + block.added.length;
      break;
    }
  }
  return places;
}

interface ReloadOutcome {
  reloaded: string[];
  unchanged: string[];
  skippedModified: string[];
  missing: string[];
}

export interface WatchDeps {
  sdk(): Sdk;
  service: HelixService;
  settings(): Promise<{ autoReload: boolean; followAgent: boolean }>;
  log(message: string): void;
  /** Every edit the agent made, for the turn's changes list (follow.ts). */
  edited?(edit: FileEdit): void;
  /** Every completed item of a followed turn (the file tree's trail reads its file changes). */
  completed?(threadId: string, item: unknown, root: string | null): void;
  /** Follow this thread's turn even with no Helix serving it (its file tree shows the agent's trail). */
  wanted?(threadId: string): boolean;
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
    if (!this.serving(environmentId).some((i) => i.summary.capabilities.includes("reload") || i.summary.capabilities.includes("watch")) && !this.deps.wanted?.(threadId)) return;
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
      this.deps.completed?.(threadId, row.data?.item, root);
      const paths = editedPaths(row.data?.item, root);
      if (!paths) continue;
      await this.onEdit({ threadId, environmentId, paths, diffs: editedDiffs(row.data?.item, root), at: typeof row.createdAt === "number" ? row.createdAt : Date.now() });
    }
  }

  /**
   * Reload exactly the edited files in every Helix serving the environment.
   * A Helix with `watch` reloads them itself (and shows them): then only the
   * navigation is left, opening a file the agent edited that is not open.
   */
  async onEdit(edit: FileEdit): Promise<void> {
    this.deps.service.noteAgentEdit(edit.environmentId);
    this.deps.edited?.(edit);
    const settings = await this.deps.settings();
    if (!settings.autoReload) return;
    for (const instance of this.serving(edit.environmentId)) {
      const caps = new Set(instance.summary.capabilities);
      if (caps.has("watch")) {
        if (settings.followAgent && caps.has("reveal")) await this.openUnopened(instance, edit).catch((error: unknown) => this.deps.log(`opening an edited file on ${instance.key} failed: ${String(error)}`));
        continue;
      }
      if (!caps.has("reload")) continue;
      const reveal = caps.has("reveal");
      const follow = reveal && settings.followAgent;
      try {
        const result = await this.deps.service.bridge.call<ReloadOutcome>(instance.key, "editor/reload", {
          paths: edit.paths,
          ...(reveal ? { reveal: true } : {}),
          ...(follow ? { follow: true, interrupt: "whenIdle" } : {}),
        });
        this.deps.timing?.(edit, Date.now() - edit.at, instance);
        // A file that is not open is in none of the lists. Following, open it
        // where the agent wrote and play the reveal there (editor/reveal with
        // follow opens it); reloads that moved the view win.
        if (follow && result.reloaded.length === 0) await this.revealUnopened(instance, edit, result);
      } catch (error) {
        this.deps.log(`reload after an agent edit on ${instance.key} failed: ${String(error)}`);
      }
    }
  }

  /** `watch`: Helix reloads open files by itself; open the edited files it does not have. */
  private async openUnopened(instance: BoundInstance, edit: FileEdit): Promise<void> {
    const state = await this.deps.service.bridge.call<{ documents: { path: string | null }[] }>(instance.key, "editor/state", {});
    const open = new Set(state.documents.map((d) => d.path).filter((p): p is string => Boolean(p)));
    await this.revealUnopened(instance, edit, { reloaded: [...open].filter((p) => edit.paths.includes(p)), unchanged: [], skippedModified: [], missing: [] });
  }

  /**
   * `event/reloaded` from Helix's own watcher: while an agent's turn runs and
   * "Follow the agent" is on, move the view to the change (Helix has already
   * reloaded it and played the reveal).
   */
  async onReloaded(instance: BoundInstance, event: { path?: unknown; origin?: unknown; ranges?: unknown }): Promise<void> {
    if (event.origin !== "watch" || typeof event.path !== "string" || !instance.environmentId || !this.watching(instance.environmentId)) return;
    if (!(await this.deps.settings()).followAgent) return;
    const first = Array.isArray(event.ranges) ? (event.ranges[0] as { start?: { line?: number } } | undefined) : undefined;
    const line = typeof first?.start?.line === "number" ? first.start.line : 1;
    await this.deps.service.bridge.call(instance.key, "editor/open", { path: event.path, line, interrupt: "whenIdle" });
  }

  private async revealUnopened(instance: BoundInstance, edit: FileEdit, result: ReloadOutcome): Promise<void> {
    const listed = new Set([...result.reloaded, ...result.unchanged, ...result.skippedModified, ...result.missing]);
    for (const path of edit.paths) {
      if (listed.has(path)) continue;
      const diff = edit.diffs?.get(path);
      if (!diff) continue;
      const { text } = await this.deps.service.bridge.call<{ text: string }>(instance.key, "editor/text", { path });
      const reveal = revealOf(diff, text);
      if (!reveal) continue;
      await this.deps.service.bridge.call(instance.key, "editor/reveal", { path, ...reveal, follow: true, interrupt: "whenIdle" });
      return;
    }
  }
}
