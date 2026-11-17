// Reviewing changes in the editor (docs/HELIX_BRIDGE.md, "Reviewing changes in
// the editor"; PROTOCOL.md `review/set`). Helix draws the diff and owns the
// picker; this works out what a review is (its base revision, files and
// hunks) for a target the user or an agent names, keeps it current while it
// is active, and lists every hunk as the `review` locations list so
// `:bb-next` walks the whole review.
//
// Targets (the rail's scopes): uncommitted (against HEAD), branch (against
// where it forked from the environment's base branch), pr (the same for the
// thread's pull request), commit <sha> (against its parent), off. "What
// changed since I looked" is bb's viewed marks (the rail), not a snapshot.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { BoundInstance } from "./bridge";
import { BridgeFailure } from "./bridge";
import { diffHunks } from "./follow";
import type { LocationItem } from "../shared/protocol";
import type { HelixService } from "./service";

type Sdk = BbPluginApi["sdk"];

const DEBOUNCE_MS = 700;
const MAX_FILES = 5000;
const MAX_HUNKS = 2000;

export type ReviewTarget = { kind: "uncommitted" } | { kind: "branch" } | { kind: "pr" } | { kind: "commit"; rev: string } | { kind: "off" };
/** A review's scope as the rail shows it. */
export type ReviewScope = "uncommitted" | "branch" | "pr" | "commit";

/** What the user typed after `:bb-review`, or an agent's target. */
export function parseTarget(text: string): ReviewTarget | { error: string } {
  const [word = "", ...rest] = text.trim().split(/\s+/u);
  switch (word.toLowerCase()) {
    case "":
    case "uncommitted":
      return { kind: "uncommitted" };
    case "branch":
      return { kind: "branch" };
    case "pr":
      return { kind: "pr" };
    case "off":
      return { kind: "off" };
    case "commit": {
      const rev = rest.join(" ").trim();
      if (!/^[\w./~^@{}-]{1,200}$/u.test(rev) || rev.startsWith("-")) return { error: "commit needs a revision: commit <sha>" };
      return { kind: "commit", rev };
    }
    default:
      // A bare sha is a commit.
      if (/^[0-9a-f]{7,40}$/u.test(word) && rest.length === 0) return { kind: "commit", rev: word };
      return { error: `unknown review target "${word}": uncommitted, branch, pr, commit <sha> or off` };
  }
}

export interface ReviewFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  oldPath?: string;
  additions: number;
  deletions: number;
  /** bb's Git revision of the file (`<oldMode>:<oldBlob>:<newMode>:<newBlob>`), for viewed marks and patches. */
  revision?: string;
  binary?: boolean;
}

export interface Resolved {
  title: string;
  base: string | null;
  files: ReviewFile[];
  hunks: LocationItem[];
  /** The bb Git target the files came from (viewed marks and patches use it). */
  gitTarget: Record<string, string>;
  /** bb's Git listed only part of the files. */
  truncated: boolean;
  /** The commit, for a commit review. */
  sha?: string;
}

export interface ActiveReview {
  id: string;
  instanceKey: string;
  threadId: string | null;
  environmentId: string;
  target: ReviewTarget;
  title: string;
  base: string | null;
  files: number;
  additions: number;
  deletions: number;
  digest: string;
  startedAt: number;
  /** The last listing, for the rail (no git read of its own). */
  resolved: Resolved;
}

export interface ReviewDeps {
  sdk(): Sdk;
  service: HelixService;
  gitRead(hostId: string, input: { cwd: string; op: "revParse" | "subject"; rev?: string }): Promise<{ sha?: string | null; subject?: string; error: string | null }>;
  /** A review started, changed or ended (the app reads reviewState again). */
  changed(threadId: string | null): void;
  /** Every git read a review makes, for the plugin log (bb plugin logs helix-bridge). */
  trace?(message: string): void;
  /** Remember (or forget, with null) the review active in a Helix, across plugin reloads. */
  persist?(instance: BoundInstance, review: { id: string; target: string } | null): void;
  /** The review remembered for a Helix. */
  recall?(instance: BoundInstance): { id: string; target: string } | null;
  log(message: string): void;
}

const filesSchema = z
  .object({
    outcome: z.string(),
    files: z.array(z.object({ path: z.string(), previousPath: z.string().nullable(), changeKind: z.string(), additions: z.number(), deletions: z.number(), revision: z.string().optional(), binary: z.boolean().optional() }).passthrough()).optional(),
    truncated: z.boolean().optional(),
    mergeBaseRef: z.string().nullable().optional(),
    reason: z.string().optional(),
  })
  .passthrough();
const diffSchema = z.object({ outcome: z.string(), diff: z.object({ diff: z.string() }).passthrough().optional() }).passthrough();
const statusSchema = z
  .object({
    outcome: z.string(),
    workspace: z
      .object({ branch: z.object({ currentBranch: z.string().nullable().optional(), defaultBranch: z.string().nullable().optional() }).passthrough().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();
const prSchema = z.record(
  z.string(),
  z.object({ outcome: z.string(), pullRequest: z.object({ number: z.number(), baseRefName: z.string() }).passthrough().optional() }).passthrough(),
);

function statusOf(changeKind: string): ReviewFile["status"] {
  if (changeKind === "added" || changeKind === "copied") return "added";
  if (changeKind === "deleted") return "deleted";
  if (changeKind === "renamed") return "renamed";
  return "modified";
}

export class Reviews {
  private readonly active = new Map<string, ActiveReview>();
  /** Per Helix: each reviewed file's first changed line (absolute path → line). */
  private readonly firstChanges = new Map<string, Map<string, number>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly deps: ReviewDeps) {}

  forThread(threadId: string): ActiveReview | null {
    for (const review of this.active.values()) if (review.threadId === threadId) return review;
    return null;
  }

  forInstance(key: string): ActiveReview | null {
    return this.active.get(key) ?? null;
  }

  /** Where this file's first change is in the active review, if it has one. */
  firstChange(key: string, path: string): number | null {
    return this.firstChanges.get(key)?.get(path) ?? null;
  }

  // ----- resolving ----------------------------------------------------------

  private async bbGitFiles(environmentId: string, target: Record<string, string>): Promise<z.infer<typeof filesSchema>> {
    this.deps.trace?.(`git read: bb--git files ${JSON.stringify(target)} in ${environmentId}`);
    const result = await this.deps.sdk().plugins.callRpc({ pluginId: "bb--git", method: "files", input: { environmentId, target, ignoreWhitespace: false }, outputSchema: filesSchema });
    if (result.outcome === "not_applicable") throw new BridgeFailure("unsupported", "this environment is not a git repository");
    if (result.outcome !== "available") throw new BridgeFailure("unsupported", `git reads are unavailable here (${result.reason ?? result.outcome})`);
    return result;
  }

  private async bbGitHunks(environmentId: string, target: Record<string, string>, root: string): Promise<LocationItem[]> {
    this.deps.trace?.(`git read: bb--git diff ${JSON.stringify(target)} in ${environmentId}`);
    const result = await this.deps.sdk().plugins.callRpc({ pluginId: "bb--git", method: "diff", input: { environmentId, target, maxDiffBytes: 2_000_000 }, outputSchema: diffSchema });
    return result.outcome === "available" && result.diff ? diffHunks(result.diff.diff, root).map((h) => h.item) : [];
  }

  private filesFrom(result: z.infer<typeof filesSchema>): ReviewFile[] {
    return (result.files ?? []).map((f) => ({
      path: f.path,
      status: statusOf(f.changeKind),
      ...(f.previousPath ? { oldPath: f.previousPath } : {}),
      additions: f.additions,
      deletions: f.deletions,
      ...(f.revision ? { revision: f.revision } : {}),
      ...(f.binary ? { binary: true } : {}),
    }));
  }

  async resolve(instance: BoundInstance, target: Exclude<ReviewTarget, { kind: "off" }>): Promise<Resolved> {
    const environmentId = instance.environmentId;
    const root = instance.environmentPath;
    if (!environmentId || !root) throw new BridgeFailure("unsupported", "this Helix is not in a bb environment");
    const git = async (op: "revParse" | "subject", rev?: string) => {
      this.deps.trace?.(`git read: host ${op}${rev ? ` ${rev}` : ""} in ${root}`);
      const result = await this.deps.gitRead(instance.hostId, { cwd: root, op, ...(rev ? { rev } : {}) });
      if (result.error) throw new BridgeFailure("unsupported", result.error);
      return result;
    };
    switch (target.kind) {
      case "uncommitted": {
        const t = { type: "uncommitted" };
        const result = await this.bbGitFiles(environmentId, t);
        return { title: "Uncommitted changes", base: null, files: this.filesFrom(result), hunks: await this.bbGitHunks(environmentId, t, root), gitTarget: t, truncated: result.truncated === true };
      }
      case "branch":
      case "pr": {
        let against: string;
        let title: string;
        if (target.kind === "pr") {
          const prs = await this.deps.sdk().plugins.callRpc({ pluginId: "bb--github-pr-status", method: "pullRequests", input: { keys: [environmentId] }, outputSchema: prSchema });
          const pr = prs[environmentId];
          if (!pr || pr.outcome !== "available" || !pr.pullRequest) throw new BridgeFailure("not_found", "this branch has no pull request");
          against = pr.pullRequest.baseRefName;
          title = `Pull request #${pr.pullRequest.number} against ${against}`;
        } else {
          this.deps.trace?.(`git read: bb--git workspaceStatus in ${environmentId}`);
          const status = await this.deps.sdk().plugins.callRpc({ pluginId: "bb--git", method: "workspaceStatus", input: { environmentId }, outputSchema: statusSchema });
          against = status.workspace?.branch?.defaultBranch ?? "main";
          const current = status.workspace?.branch?.currentBranch ?? null;
          title = current && current !== against ? `${current} against ${against}` : `Changes against ${against}`;
        }
        const t = { type: "all", mergeBaseBranch: against };
        const result = await this.bbGitFiles(environmentId, t);
        if (!result.mergeBaseRef) throw new BridgeFailure("not_found", `no merge base with ${against}`);
        return { title, base: result.mergeBaseRef, files: this.filesFrom(result), hunks: await this.bbGitHunks(environmentId, t, root), gitTarget: t, truncated: result.truncated === true };
      }
      case "commit": {
        const sha = (await git("revParse", target.rev)).sha;
        if (!sha) throw new BridgeFailure("not_found", `no commit ${target.rev} in this repository`);
        const parent = (await git("revParse", `${sha}^`)).sha;
        if (!parent) throw new BridgeFailure("unsupported", `${sha.slice(0, 7)} has no parent to compare with`);
        const subject = (await git("subject", sha)).subject ?? "";
        const t = { type: "commit", sha };
        const result = await this.bbGitFiles(environmentId, t);
        return { title: `Commit ${sha.slice(0, 7)}${subject ? `: ${subject}` : ""}`, base: parent, files: this.filesFrom(result), hunks: await this.bbGitHunks(environmentId, t, root), gitTarget: t, truncated: result.truncated === true, sha };
      }
    }
  }

  // ----- starting, keeping, ending --------------------------------------------

  /** Start a review on this Helix (or end it with `off`). Returns the status-line text. */
  async start(instance: BoundInstance, targetText: string, options: { open?: boolean; interrupt?: "whenIdle" | "always" } = {}): Promise<string> {
    if (!instance.summary.capabilities.includes("review")) throw new BridgeFailure("unsupported", "this Helix does not offer reviews yet");
    const target = parseTarget(targetText);
    if ("error" in target) throw new BridgeFailure("invalid_params", target.error);
    if (target.kind === "off") return this.end(instance);
    const resolved = await this.resolve(instance, target);
    const previous = this.active.get(instance.key);
    const id = previous && JSON.stringify(previous.target) === JSON.stringify(target) ? previous.id : `rv_${randomUUID().slice(0, 12)}`;
    await this.send(instance, id, resolved, { activate: true, open: options.open ?? false, ...(options.interrupt ? { interrupt: options.interrupt } : {}) });
    const review: ActiveReview = {
      id,
      instanceKey: instance.key,
      threadId: instance.threadId,
      environmentId: instance.environmentId!,
      target,
      title: resolved.title,
      base: resolved.base,
      files: resolved.files.length,
      additions: resolved.files.reduce((n, f) => n + f.additions, 0),
      deletions: resolved.files.reduce((n, f) => n + f.deletions, 0),
      digest: digestOf(resolved),
      startedAt: Date.now(),
      resolved,
    };
    this.active.set(instance.key, review);
    this.firstChanges.set(instance.key, firstChangesOf(resolved));
    this.deps.persist?.(instance, { id, target: targetText.trim() || "uncommitted" });
    this.deps.changed(review.threadId);
    if (resolved.files.length === 0) return `${resolved.title}: no changes yet (the review follows new ones)`;
    return `Reviewing ${resolved.title}: ${resolved.files.length} file${resolved.files.length === 1 ? "" : "s"}, +${review.additions} -${review.deletions}`;
  }

  async end(instance: BoundInstance): Promise<string> {
    const review = this.active.get(instance.key);
    this.active.delete(instance.key);
    this.firstChanges.delete(instance.key);
    this.deps.persist?.(instance, null);
    await this.deps.service.bridge.call(instance.key, "review/clear", {});
    await this.deps.service.bridge.call(instance.key, "locations/clear", { list: "review" }).catch(() => null);
    this.deps.changed(review?.threadId ?? instance.threadId);
    return review ? `Review ended: ${review.title}` : "No review was active";
  }

  /**
   * After a plugin reload: the review this Helix still shows, if it is the
   * one remembered for it, becomes active again (resolved once, without
   * moving the user or touching the inline diff). Anything else is forgotten.
   */
  async adopt(instance: BoundInstance): Promise<boolean> {
    if (this.active.has(instance.key) || !instance.summary.capabilities.includes("review")) return false;
    const saved = this.deps.recall?.(instance);
    if (!saved) return false;
    const state = await this.deps.service.bridge.call<{ active?: boolean; id?: string | null }>(instance.key, "review/state", {}).catch(() => null);
    const target = parseTarget(saved.target);
    if (!state?.active || state.id !== saved.id || "error" in target || target.kind === "off") {
      this.deps.persist?.(instance, null);
      return false;
    }
    const resolved = await this.resolve(instance, target).catch(() => null);
    if (!resolved || this.active.has(instance.key)) return false;
    await this.send(instance, saved.id, resolved, { activate: false });
    this.active.set(instance.key, {
      id: saved.id,
      instanceKey: instance.key,
      threadId: instance.threadId,
      environmentId: instance.environmentId!,
      target,
      title: resolved.title,
      base: resolved.base,
      files: resolved.files.length,
      additions: resolved.files.reduce((n, f) => n + f.additions, 0),
      deletions: resolved.files.reduce((n, f) => n + f.deletions, 0),
      digest: digestOf(resolved),
      startedAt: Date.now(),
      resolved,
    });
    this.firstChanges.set(instance.key, firstChangesOf(resolved));
    this.deps.changed(instance.threadId);
    return true;
  }

  /** Turn the active review's inline diff on or off (the same id: nothing else moves). */
  async setInline(instance: BoundInstance, inline: boolean): Promise<void> {
    const review = this.active.get(instance.key);
    if (!review) throw new BridgeFailure("not_found", "no review is active");
    await this.send(instance, review.id, review.resolved, { activate: false, inline });
  }

  private async send(instance: BoundInstance, id: string, resolved: Resolved, options: { activate: boolean; open?: boolean; inline?: boolean; interrupt?: "whenIdle" | "always" }): Promise<void> {
    const root = instance.environmentPath!;
    await this.deps.service.bridge.call(instance.key, "review/set", {
      id,
      title: resolved.title,
      base: resolved.base ? { rev: resolved.base } : null,
      files: resolved.files.slice(0, MAX_FILES).map((f) => ({ path: join(root, f.path), status: f.status, ...(f.oldPath ? { oldPath: join(root, f.oldPath) } : {}), additions: f.additions, deletions: f.deletions })),
      // `inline` omitted unless asked: a new review turns the inline diff on,
      // and the same id sent again leaves it as the user set it.
      ...(options.inline !== undefined ? { inline: options.inline } : {}),
      open: options.open ?? false,
      ...(options.interrupt ? { interrupt: options.interrupt } : {}),
    });
    if (instance.summary.capabilities.includes("locations")) {
      await this.deps.service.bridge.call(instance.key, "locations/set", { list: "review", title: resolved.title, items: resolved.hunks.slice(0, MAX_HUNKS), activate: options.activate });
    }
  }

  /**
   * Refresh the active reviews in an environment soon. Only on signals the
   * plugin already has: a Helix reload or save there, bb's environment change
   * event, the end of an agent turn; and when the owner asks again. No timer:
   * each refresh is a git status and diff, felt in a large repository.
   */
  noteChange(environmentId: string): void {
    for (const review of this.active.values()) {
      if (review.environmentId !== environmentId) continue;
      clearTimeout(this.timers.get(review.instanceKey));
      this.timers.set(
        review.instanceKey,
        setTimeout(() => {
          this.timers.delete(review.instanceKey);
          void this.refresh(review.instanceKey);
        }, DEBOUNCE_MS),
      );
    }
  }

  /** Re-resolve an active review and re-send it (same id, without moving the user) when it changed. */
  async refresh(key: string): Promise<void> {
    const review = this.active.get(key);
    if (!review || review.target.kind === "off") return;
    const instance = this.deps.service.bridge.get(key);
    if (!instance || instance.summary.status !== "connected") {
      this.active.delete(key);
      this.firstChanges.delete(key);
      this.deps.changed(review.threadId);
      return;
    }
    try {
      const resolved = await this.resolve(instance, review.target);
      const digest = digestOf(resolved);
      if (digest === review.digest) return;
      await this.send(instance, review.id, resolved, { activate: false });
      Object.assign(review, {
        title: resolved.title,
        base: resolved.base,
        files: resolved.files.length,
        additions: resolved.files.reduce((n, f) => n + f.additions, 0),
        deletions: resolved.files.reduce((n, f) => n + f.deletions, 0),
        digest,
        resolved,
      });
      this.firstChanges.set(key, firstChangesOf(resolved));
      this.deps.changed(review.threadId);
    } catch (error) {
      this.deps.log(`refreshing review ${review.id} failed: ${String(error)}`);
    }
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}

function firstChangesOf(resolved: Resolved): Map<string, number> {
  const firsts = new Map<string, number>();
  for (const hunk of resolved.hunks) if (!firsts.has(hunk.path) || hunk.line < firsts.get(hunk.path)!) firsts.set(hunk.path, hunk.line);
  return firsts;
}

function digestOf(resolved: Resolved): string {
  return JSON.stringify([resolved.title, resolved.base, resolved.files, resolved.truncated, resolved.hunks.length, resolved.hunks.map((h) => `${h.path}:${h.line}:${h.label ?? ""}`)]);
}
