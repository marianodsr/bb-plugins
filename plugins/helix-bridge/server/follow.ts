// Follow the agent. When bb reports file changes in an environment, reload
// the buffers of the Helix instances serving it (debounced; unsaved buffers
// are skipped and reported, never forced). When a turn ends, reload again and
// set the `changes` location list from bb's Git plugin: the uncommitted hunks
// plus whatever the turn committed (the diff from HEAD at turn start).
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { LocationItem, ReloadResult } from "../shared/protocol";
import type { BoundInstance } from "./bridge";
import { displayPath, rootsOf } from "./format";
import type { HelixService } from "./service";

type Sdk = BbPluginApi["sdk"];

const RELOAD_DEBOUNCE_MS = 400;
const WATCHED_DEBOUNCE_MS = 2500;
const MAX_CHANGES = 2000;

/**
 * Changed lines of a unified diff as location items, one per hunk. The span
 * and the `+a -r` label count the changed lines only, not the context git
 * puts around them (a hunk without a body, as `-U0` headers alone, uses the
 * header's counts). Deleted files are skipped.
 */
export function hunksFromDiff(diff: string, root: string): LocationItem[] {
  return diffHunks(diff, root).map((h) => h.item);
}

/** As `hunksFromDiff`, each with a key (path and changed lines) to tell hunks apart across two diffs. */
export function diffHunks(diff: string, root: string): { item: LocationItem; key: string }[] {
  const items: { item: LocationItem; key: string }[] = [];
  let path: string | null = null;
  let hunk: { start: number; added: number; removed: number; body: string[] } | null = null;
  const finish = () => {
    if (!hunk || !path) return;
    let line = hunk.start;
    let first: number | null = null;
    let last: number | null = null;
    let added = 0;
    let removed = 0;
    for (const body of hunk.body) {
      if (body.startsWith("+")) {
        first ??= line;
        last = line;
        added += 1;
        line += 1;
      } else if (body.startsWith("-")) {
        first ??= line;
        removed += 1;
      } else if (body.startsWith(" ") || body === "") line += 1;
    }
    if (added === 0 && removed === 0) {
      ({ added, removed } = hunk);
      first = hunk.start;
      last = added > 0 ? hunk.start + added - 1 : null;
    }
    const label = `+${added} -${removed}`;
    const key = `${path}\0${hunk.body.filter((b) => b.startsWith("+") || b.startsWith("-")).join("\n") || `${hunk.start},${hunk.added},${hunk.removed}`}`;
    // A pure deletion has no new lines; point at the line after it.
    items.push({ item: added > 0 && last !== null ? { path, line: first ?? hunk.start, endLine: last, label } : { path, line: Math.max(1, first ?? hunk.start), label }, key });
    hunk = null;
  };
  for (const line of diff.split("\n")) {
    if (items.length >= MAX_CHANGES) break;
    if (line.startsWith("diff --git ") || line.startsWith("--- ")) {
      finish();
      continue;
    }
    if (line.startsWith("+++ ")) {
      finish();
      const target = line.slice(4).trim();
      path = target === "/dev/null" ? null : `${root.replace(/\/$/u, "")}/${target.replace(/^b\//u, "")}`;
      continue;
    }
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line);
    if (match) {
      finish();
      if (path) hunk = { start: Number(match[3]), removed: match[2] === undefined ? 1 : Number(match[2]), added: match[4] === undefined ? 1 : Number(match[4]), body: [] };
      continue;
    }
    if (hunk && !line.startsWith("\\")) hunk.body.push(line);
  }
  finish();
  return items.slice(0, MAX_CHANGES);
}

const statusSchema = z.object({ outcome: z.string(), workspace: z.object({ checkout: z.object({ headSha: z.string().nullable().optional() }).passthrough() }).passthrough().optional() }).passthrough();
const diffSchema = z.object({ outcome: z.string(), diff: z.object({ diff: z.string(), truncated: z.boolean() }).passthrough().optional() }).passthrough();

export interface FollowDeps {
  sdk(): Sdk;
  service: HelixService;
  settings(): Promise<{ autoReload: boolean; followAgent: boolean }>;
  /** An agent turn's edits are being reloaded one by one (watch.ts). */
  watching?(environmentId: string): boolean;
  log(message: string): void;
  /** Unsaved buffers were not reloaded: tell the user in bb too. */
  skipped(instance: BoundInstance, paths: string[]): void;
}

export class Follower {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly turnStartHead = new Map<string, string>();
  /** Per thread: the hunks already uncommitted when its turn started. */
  private readonly turnStartHunks = new Map<string, Set<string>>();
  readonly lastReload = new Map<string, { at: number; result: ReloadResult }>();

  constructor(private readonly deps: FollowDeps) {}

  /** Instances that serve an environment (bound there, or with their workspace in it). */
  private serving(environmentId: string): BoundInstance[] {
    return this.deps.service.bridge.list().filter((i) => i.summary.status === "connected" && i.environmentId === environmentId);
  }

  onEnvironmentChanged(environmentId: string): void {
    if (this.serving(environmentId).length === 0) return;
    clearTimeout(this.timers.get(environmentId));
    // While a turn's edits are reloaded (with the reveal) as they land, this
    // catch-all reload waits so it does not reload them first, unanimated.
    const delay = this.deps.watching?.(environmentId) ? WATCHED_DEBOUNCE_MS : RELOAD_DEBOUNCE_MS;
    this.timers.set(
      environmentId,
      setTimeout(() => {
        this.timers.delete(environmentId);
        void this.reloadEnvironment(environmentId);
      }, delay),
    );
  }

  private async reloadEnvironment(environmentId: string): Promise<void> {
    if (!(await this.deps.settings()).autoReload) return;
    for (const instance of this.serving(environmentId)) await this.reload(instance);
  }

  async reload(instance: BoundInstance): Promise<ReloadResult | null> {
    // A Helix with `watch` reloads its buffers itself.
    if (!instance.summary.capabilities.includes("reload") || instance.summary.capabilities.includes("watch")) return null;
    try {
      const result = await this.deps.service.reload(instance);
      this.lastReload.set(instance.key, { at: Date.now(), result });
      if (result.skippedModified.length > 0) {
        const roots = rootsOf(instance);
        const names = result.skippedModified.slice(0, 3).map((p) => displayPath(p, roots)).join(", ");
        await this.deps.service.status(instance, `Not reloaded, unsaved changes: ${names}${result.skippedModified.length > 3 ? ` and ${result.skippedModified.length - 3} more` : ""}`, "warning");
        this.deps.skipped(instance, result.skippedModified);
      }
      return result;
    } catch (error) {
      this.deps.log(`reload of ${instance.key} failed: ${String(error)}`);
      return null;
    }
  }

  private async head(environmentId: string): Promise<string | null> {
    try {
      const status = await this.deps.sdk().plugins.callRpc({ pluginId: "bb--git", method: "workspaceStatus", input: { environmentId }, outputSchema: statusSchema });
      return status.workspace?.checkout.headSha ?? null;
    } catch {
      return null;
    }
  }

  async onTurnStart(threadId: string, environmentId: string | null): Promise<void> {
    if (!environmentId || this.serving(environmentId).length === 0) return;
    const sha = await this.head(environmentId);
    if (sha) this.turnStartHead.set(threadId, sha);
    // Changes left from earlier turns (or the user) are not this turn's.
    const info = await this.deps.service.threadInfo(threadId);
    const before = info.path ? await this.diff(environmentId, { type: "uncommitted" }, info.path).catch(() => null) : null;
    if (before) this.turnStartHunks.set(threadId, new Set(before.map((h) => h.key)));
  }

  private async diff(environmentId: string, target: Record<string, string>, root: string): Promise<{ item: LocationItem; key: string }[] | null> {
    const result = await this.deps.sdk().plugins.callRpc({ pluginId: "bb--git", method: "diff", input: { environmentId, target, maxDiffBytes: 2_000_000 }, outputSchema: diffSchema });
    if (result.outcome !== "available" || !result.diff) return null;
    return diffHunks(result.diff.diff, root);
  }

  async onTurnEnd(threadId: string, environmentId: string | null): Promise<void> {
    if (!environmentId) return;
    const instances = this.serving(environmentId);
    const start = this.turnStartHead.get(threadId) ?? null;
    const before = this.turnStartHunks.get(threadId) ?? null;
    this.turnStartHead.delete(threadId);
    this.turnStartHunks.delete(threadId);
    if (instances.length === 0) return;
    const settings = await this.deps.settings();
    if (settings.autoReload) for (const instance of instances) await this.reload(instance);
    if (!settings.followAgent) return;
    const info = await this.deps.service.threadInfo(threadId);
    if (!info.path) return;
    const now = await this.head(environmentId);
    const target: Record<string, string> = start && now && start !== now ? { type: "all", mergeBaseBranch: start } : { type: "uncommitted" };
    let items: LocationItem[] = [];
    try {
      const hunks = await this.diff(environmentId, target, info.path);
      if (!hunks) return;
      // Both diffs are against the HEAD the turn started on, so a hunk that
      // was already there is the same text.
      items = hunks.filter((h) => !before?.has(h.key)).map((h) => h.item);
    } catch (error) {
      this.deps.log(`changes for ${threadId} failed: ${String(error)}`);
      return;
    }
    // A turn that changed nothing leaves the last list as it was.
    if (items.length === 0 && before) return;
    const files = new Set(items.map((i) => i.path)).size;
    for (const instance of instances) {
      if (!instance.summary.capabilities.includes("locations")) continue;
      try {
        await this.deps.service.bridge.call(instance.key, "locations/set", { list: "changes", title: `Agent changes: ${info.title ?? threadId}`, items, activate: items.length > 0 });
        if (items.length > 0) await this.deps.service.status(instance, `Agent changed ${items.length} place${items.length === 1 ? "" : "s"} in ${files} file${files === 1 ? "" : "s"} (:bb-next)`);
      } catch (error) {
        this.deps.log(`locations/set on ${instance.key} failed: ${String(error)}`);
      }
    }
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
