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
import { type FileEdit, placesOf } from "./watch";

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
  /** Per running turn: the agent's diffs by file, and Helix's own reload ranges. */
  private readonly turns = new Map<string, { diffs: Map<string, string[]>; reloaded: Map<string, { start: { line: number }; end: { line: number; col: number } }[]> }>();
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



  /** A turn starts: its changes list starts empty. No git: see onTurnEnd. */
  onTurnStart(threadId: string): void {
    this.turns.set(threadId, { diffs: new Map(), reloaded: new Map() });
  }

  /** An edit the agent made with its edit tools (the fileChange item's diff). */
  noteEdit(edit: FileEdit): void {
    const turn = this.turns.get(edit.threadId);
    if (!turn) return;
    for (const path of edit.paths) {
      const diff = edit.diffs?.get(path);
      turn.diffs.set(path, [...(turn.diffs.get(path) ?? []), ...(diff ? [diff] : [])]);
    }
  }

  /** Helix reloaded a file by itself during a turn (`watch`): shell edits included. */
  noteReloaded(threadId: string | null, path: string, ranges: { start: { line: number }; end: { line: number; col: number } }[]): void {
    const turn = threadId ? this.turns.get(threadId) : undefined;
    if (turn) turn.reloaded.set(path, ranges);
  }

  /**
   * The turn ended: the places it changed, from what the plugin saw during
   * the turn (the agent's diffs, Helix's own reloads), located in each file's
   * current text read once through Helix. No git: in a large repository a
   * status or diff on every turn is a cost the user feels.
   */
  async onTurnEnd(threadId: string, environmentId: string | null): Promise<void> {
    const turn = this.turns.get(threadId);
    this.turns.delete(threadId);
    if (!environmentId) return;
    const instances = this.serving(environmentId);
    if (instances.length === 0) return;
    const settings = await this.deps.settings();
    if (settings.autoReload) for (const instance of instances) await this.reload(instance);
    if (!settings.followAgent || !turn || (turn.diffs.size === 0 && turn.reloaded.size === 0)) return;
    const reader = instances.find((i) => i.summary.capabilities.includes("editor"));
    if (!reader) return;
    const items: LocationItem[] = [];
    for (const path of new Set([...turn.diffs.keys(), ...turn.reloaded.keys()])) {
      const diffs = turn.diffs.get(path) ?? [];
      let placed: { line: number; endLine?: number; label: string }[] = [];
      if (diffs.length > 0) {
        const text = await this.deps.service.bridge.call<{ text: string }>(reader.key, "editor/text", { path }).then((r) => r.text, () => null);
        if (text !== null) placed = diffs.flatMap((d) => placesOf(d, text));
      }
      if (placed.length === 0) {
        // Reloaded by Helix (shell edits too): its last ranges for this file.
        placed = (turn.reloaded.get(path) ?? []).map((r) => {
          const last = r.end.col === 1 ? r.end.line - 1 : r.end.line;
          return { line: r.start.line, ...(last > r.start.line ? { endLine: last } : {}), label: "changed" };
        });
      }
      if (placed.length === 0) placed = [{ line: 1, label: "changed" }];
      const seen = new Set<number>();
      for (const p of placed.sort((a, b) => a.line - b.line)) {
        if (seen.has(p.line)) continue;
        seen.add(p.line);
        items.push({ path, ...p });
      }
      if (items.length >= MAX_CHANGES) break;
    }
    if (items.length === 0) return;
    const info = await this.deps.service.threadInfo(threadId);
    const files = new Set(items.map((i) => i.path)).size;
    for (const instance of instances) {
      if (!instance.summary.capabilities.includes("locations")) continue;
      try {
        await this.deps.service.bridge.call(instance.key, "locations/set", { list: "changes", title: `Agent changes: ${info.title ?? threadId}`, items: items.slice(0, MAX_CHANGES), activate: true });
        await this.deps.service.status(instance, `Agent changed ${items.length} place${items.length === 1 ? "" : "s"} in ${files} file${files === 1 ? "" : "s"} (:bb-next)`);
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
