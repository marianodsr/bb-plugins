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
const MAX_CHANGES = 2000;

/** New-side hunks of a unified diff as location items. Deleted files are skipped. */
export function hunksFromDiff(diff: string, root: string): LocationItem[] {
  const items: LocationItem[] = [];
  let path: string | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      path = target === "/dev/null" ? null : `${root.replace(/\/$/u, "")}/${target.replace(/^b\//u, "")}`;
      continue;
    }
    if (!path || !line.startsWith("@@")) continue;
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line);
    if (!match) continue;
    const removed = match[2] === undefined ? 1 : Number(match[2]);
    const start = Number(match[3]);
    const added = match[4] === undefined ? 1 : Number(match[4]);
    const label = `+${added} -${removed}`;
    // A pure deletion has no new lines; point at the line after it.
    items.push(added > 0 ? { path, line: start, endLine: start + added - 1, label } : { path, line: Math.max(1, start), label });
    if (items.length >= MAX_CHANGES) break;
  }
  return items;
}

const statusSchema = z.object({ outcome: z.string(), workspace: z.object({ checkout: z.object({ headSha: z.string().nullable().optional() }).passthrough() }).passthrough().optional() }).passthrough();
const diffSchema = z.object({ outcome: z.string(), diff: z.object({ diff: z.string(), truncated: z.boolean() }).passthrough().optional() }).passthrough();

export interface FollowDeps {
  sdk(): Sdk;
  service: HelixService;
  settings(): Promise<{ autoReload: boolean; followAgent: boolean }>;
  log(message: string): void;
  /** Unsaved buffers were not reloaded: tell the user in bb too. */
  skipped(instance: BoundInstance, paths: string[]): void;
}

export class Follower {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly turnStartHead = new Map<string, string>();
  readonly lastReload = new Map<string, { at: number; result: ReloadResult }>();

  constructor(private readonly deps: FollowDeps) {}

  /** Instances that serve an environment (bound there, or with their workspace in it). */
  private serving(environmentId: string): BoundInstance[] {
    return this.deps.service.bridge.list().filter((i) => i.summary.status === "connected" && i.environmentId === environmentId);
  }

  onEnvironmentChanged(environmentId: string): void {
    if (this.serving(environmentId).length === 0) return;
    clearTimeout(this.timers.get(environmentId));
    this.timers.set(
      environmentId,
      setTimeout(() => {
        this.timers.delete(environmentId);
        void this.reloadEnvironment(environmentId);
      }, RELOAD_DEBOUNCE_MS),
    );
  }

  private async reloadEnvironment(environmentId: string): Promise<void> {
    if (!(await this.deps.settings()).autoReload) return;
    for (const instance of this.serving(environmentId)) await this.reload(instance);
  }

  async reload(instance: BoundInstance): Promise<ReloadResult | null> {
    if (!instance.summary.capabilities.includes("reload")) return null;
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
  }

  async onTurnEnd(threadId: string, environmentId: string | null): Promise<void> {
    if (!environmentId) return;
    const instances = this.serving(environmentId);
    const start = this.turnStartHead.get(threadId) ?? null;
    this.turnStartHead.delete(threadId);
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
      const result = await this.deps.sdk().plugins.callRpc({ pluginId: "bb--git", method: "diff", input: { environmentId, target, maxDiffBytes: 2_000_000 }, outputSchema: diffSchema });
      if (result.outcome !== "available" || !result.diff) return;
      items = hunksFromDiff(result.diff.diff, info.path);
    } catch (error) {
      this.deps.log(`changes for ${threadId} failed: ${String(error)}`);
      return;
    }
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
