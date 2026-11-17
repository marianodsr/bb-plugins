// Reviewing changes in the editor (docs/HELIX_BRIDGE.md, "Reviewing changes in
// the editor"; PROTOCOL.md `review/set`). Helix draws the diff and owns the
// picker; this works out what a review is (its base revision, files and
// hunks) for a target the user or an agent names, keeps it current while it
// is active, and lists every hunk as the `review` locations list so
// `:bb-next` walks the whole review.
//
// Targets: uncommitted (against HEAD), branch (against where it forked from
// the environment's base branch), pr (the same for the thread's pull
// request), turn (what the last agent turn changed, against the snapshot it
// started from), commit <sha> (against its parent), off.
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

const REFRESH_MS = 4000;
const DEBOUNCE_MS = 700;
const MAX_FILES = 5000;
const MAX_HUNKS = 2000;

export type ReviewTarget = { kind: "uncommitted" } | { kind: "branch" } | { kind: "pr" } | { kind: "turn" } | { kind: "commit"; rev: string } | { kind: "off" };

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
    case "turn":
      return { kind: "turn" };
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
      return { error: `unknown review target "${word}": uncommitted, branch, pr, turn, commit <sha> or off` };
  }
}

export interface ReviewFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  oldPath?: string;
  additions: number;
  deletions: number;
}

export interface Resolved {
  title: string;
  base: string | null;
  files: ReviewFile[];
  hunks: LocationItem[];
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
}

export interface ReviewDeps {
  sdk(): Sdk;
  service: HelixService;
  gitRead(hostId: string, input: { cwd: string; op: "revParse" | "subject" | "snapshot" | "changedFiles" | "diff"; rev?: string; exclude?: string[] }): Promise<{ sha?: string | null; subject?: string; base?: string | null; untracked?: string[]; files?: ReviewFile[]; diff?: string; error: string | null }>;
  /** A review started, changed or ended (the app reads reviewState again). */
  changed(threadId: string | null): void;
  log(message: string): void;
}

const filesSchema = z
  .object({
    outcome: z.string(),
    files: z.array(z.object({ path: z.string(), previousPath: z.string().nullable(), changeKind: z.string(), additions: z.number(), deletions: z.number() }).passthrough()).optional(),
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
  /** Per thread: the snapshot its last agent turn started from. */
  private readonly turnStarts = new Map<string, { base: string | null; untracked: string[]; at: number }>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private poll: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: ReviewDeps) {}

  forThread(threadId: string): ActiveReview | null {
    for (const review of this.active.values()) if (review.threadId === threadId) return review;
    return null;
  }

  forInstance(key: string): ActiveReview | null {
    return this.active.get(key) ?? null;
  }

  // ----- turns --------------------------------------------------------------

  /** An agent turn starts: remember the working tree it starts from (`turn`). */
  async onTurnStart(threadId: string, hostId: string | null, root: string | null): Promise<void> {
    if (!hostId || !root) return;
    const snap = await this.deps.gitRead(hostId, { cwd: root, op: "snapshot" }).catch(() => null);
    if (snap && !snap.error) this.turnStarts.set(threadId, { base: snap.base ?? null, untracked: snap.untracked ?? [], at: Date.now() });
  }

  // ----- resolving ----------------------------------------------------------

  private async bbGitFiles(environmentId: string, target: Record<string, string>): Promise<z.infer<typeof filesSchema>> {
    const result = await this.deps.sdk().plugins.callRpc({ pluginId: "bb--git", method: "files", input: { environmentId, target, ignoreWhitespace: false }, outputSchema: filesSchema });
    if (result.outcome === "not_applicable") throw new BridgeFailure("unsupported", "this environment is not a git repository");
    if (result.outcome !== "available") throw new BridgeFailure("unsupported", `git reads are unavailable here (${result.reason ?? result.outcome})`);
    return result;
  }

  private async bbGitHunks(environmentId: string, target: Record<string, string>, root: string): Promise<LocationItem[]> {
    const result = await this.deps.sdk().plugins.callRpc({ pluginId: "bb--git", method: "diff", input: { environmentId, target, maxDiffBytes: 2_000_000 }, outputSchema: diffSchema });
    return result.outcome === "available" && result.diff ? diffHunks(result.diff.diff, root).map((h) => h.item) : [];
  }

  private filesFrom(result: z.infer<typeof filesSchema>): ReviewFile[] {
    return (result.files ?? []).map((f) => ({ path: f.path, status: statusOf(f.changeKind), ...(f.previousPath ? { oldPath: f.previousPath } : {}), additions: f.additions, deletions: f.deletions }));
  }

  async resolve(instance: BoundInstance, target: Exclude<ReviewTarget, { kind: "off" }>): Promise<Resolved> {
    const environmentId = instance.environmentId;
    const root = instance.environmentPath;
    if (!environmentId || !root) throw new BridgeFailure("unsupported", "this Helix is not in a bb environment");
    const git = async (op: "revParse" | "subject" | "snapshot" | "changedFiles" | "diff", rev?: string, exclude?: string[]) => {
      const result = await this.deps.gitRead(instance.hostId, { cwd: root, op, ...(rev ? { rev } : {}), ...(exclude ? { exclude } : {}) });
      if (result.error) throw new BridgeFailure("unsupported", result.error);
      return result;
    };
    switch (target.kind) {
      case "uncommitted": {
        const t = { type: "uncommitted" };
        const files = this.filesFrom(await this.bbGitFiles(environmentId, t));
        return { title: "Uncommitted changes", base: null, files, hunks: await this.bbGitHunks(environmentId, t, root) };
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
          const status = await this.deps.sdk().plugins.callRpc({ pluginId: "bb--git", method: "workspaceStatus", input: { environmentId }, outputSchema: statusSchema });
          against = status.workspace?.branch?.defaultBranch ?? "main";
          const current = status.workspace?.branch?.currentBranch ?? null;
          title = current && current !== against ? `This branch (${current}) against ${against}` : `Changes against ${against}`;
        }
        const t = { type: "all", mergeBaseBranch: against };
        const result = await this.bbGitFiles(environmentId, t);
        if (!result.mergeBaseRef) throw new BridgeFailure("not_found", `no merge base with ${against}`);
        return { title, base: result.mergeBaseRef, files: this.filesFrom(result), hunks: await this.bbGitHunks(environmentId, t, root) };
      }
      case "commit": {
        const sha = (await git("revParse", target.rev)).sha;
        if (!sha) throw new BridgeFailure("not_found", `no commit ${target.rev} in this repository`);
        const parent = (await git("revParse", `${sha}^`)).sha;
        if (!parent) throw new BridgeFailure("unsupported", `${sha.slice(0, 7)} has no parent to compare with`);
        const subject = (await git("subject", sha)).subject ?? "";
        const t = { type: "commit", sha };
        const files = this.filesFrom(await this.bbGitFiles(environmentId, t));
        return { title: `Commit ${sha.slice(0, 7)}${subject ? `: ${subject}` : ""}`, base: parent, files, hunks: await this.bbGitHunks(environmentId, t, root) };
      }
      case "turn": {
        const start = instance.threadId ? this.turnStarts.get(instance.threadId) : undefined;
        if (!start?.base) throw new BridgeFailure("not_found", "no agent turn recorded for this thread since Helix Bridge started; try uncommitted or branch");
        const files = ((await git("changedFiles", start.base, start.untracked)).files ?? []) as ReviewFile[];
        const hunks = diffHunks((await git("diff", start.base)).diff ?? "", root).map((h) => h.item);
        // New files the turn created are not in a diff against a commit.
        for (const f of files) if (f.status === "added" && !hunks.some((h) => h.path === join(root, f.path))) hunks.push({ path: join(root, f.path), line: 1, ...(f.additions > 0 ? { endLine: f.additions } : {}), label: `+${f.additions} new file` });
        return { title: "The last agent turn", base: start.base, files, hunks };
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
    };
    this.active.set(instance.key, review);
    this.ensurePoll();
    this.deps.changed(review.threadId);
    if (resolved.files.length === 0) return `${resolved.title}: no changes yet (the review follows new ones)`;
    return `Reviewing ${resolved.title}: ${resolved.files.length} file${resolved.files.length === 1 ? "" : "s"}, +${review.additions} -${review.deletions} (:bb-review to browse, :bb-next to walk)`;
  }

  async end(instance: BoundInstance): Promise<string> {
    const review = this.active.get(instance.key);
    this.active.delete(instance.key);
    await this.deps.service.bridge.call(instance.key, "review/clear", {});
    await this.deps.service.bridge.call(instance.key, "locations/clear", { list: "review" }).catch(() => null);
    if (this.active.size === 0 && this.poll) {
      clearInterval(this.poll);
      this.poll = null;
    }
    this.deps.changed(review?.threadId ?? instance.threadId);
    return review ? `Review ended: ${review.title}` : "No review was active";
  }

  private async send(instance: BoundInstance, id: string, resolved: Resolved, options: { activate: boolean; open?: boolean; interrupt?: "whenIdle" | "always" }): Promise<void> {
    const root = instance.environmentPath!;
    await this.deps.service.bridge.call(instance.key, "review/set", {
      id,
      title: resolved.title,
      base: resolved.base ? { rev: resolved.base } : null,
      files: resolved.files.slice(0, MAX_FILES).map((f) => ({ path: join(root, f.path), status: f.status, ...(f.oldPath ? { oldPath: join(root, f.oldPath) } : {}), additions: f.additions, deletions: f.deletions })),
      inline: true,
      open: options.open ?? false,
      ...(options.interrupt ? { interrupt: options.interrupt } : {}),
    });
    if (instance.summary.capabilities.includes("locations")) {
      await this.deps.service.bridge.call(instance.key, "locations/set", { list: "review", title: resolved.title, items: resolved.hunks.slice(0, MAX_HUNKS), activate: options.activate });
    }
  }

  /** Files or refs changed in an environment: refresh its active reviews soon. */
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
      });
      this.deps.changed(review.threadId);
    } catch (error) {
      this.deps.log(`refreshing review ${review.id} failed: ${String(error)}`);
    }
  }

  private ensurePoll(): void {
    // Edits and ref moves are noticed through noteChange; this catches the rest
    // (a commit made in a terminal, a rebase) without depending on watchers.
    this.poll ??= setInterval(() => {
      for (const key of [...this.active.keys()]) void this.refresh(key);
    }, REFRESH_MS);
  }

  dispose(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}

function digestOf(resolved: Resolved): string {
  return JSON.stringify([resolved.title, resolved.base, resolved.files, resolved.hunks.length, resolved.hunks.map((h) => `${h.path}:${h.line}:${h.label ?? ""}`)]);
}
