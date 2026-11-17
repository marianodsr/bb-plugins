// Review comments in the code. For every environment a connected Helix with
// `annotations` serves, keep that Helix's "bb-review" annotations equal to
// the comments on each file: a gutter sign on the lines, the comment under
// them, the agent's replies under that, and nothing once a comment is
// resolved by the user or the reviewer acknowledged the agent's resolution.
//
// Comments come from Review Editor when it runs (comments made there or from
// Helix), else from this plugin's own pending list. Review Editor calls
// `commentsChanged` after every comment write, and that file is re-read at
// once; everything is also re-read when this plugin changes a comment, and
// when an instance connects or opens files. No timer. A file is re-sent only
// when its items changed, or to an instance that just connected or opened
// files.
import { createHash } from "node:crypto";
import { isAbsolute, join, normalize, sep } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { BoundInstance } from "./bridge";
import { REVIEW_EDITOR } from "./sends";
import type { HelixService } from "./service";
import type { LocalComment, Store } from "./store";

type Sdk = BbPluginApi["sdk"];

export const NAMESPACE = "bb-review";
const MAX_TEXT = 2000;

export interface AnnotationItem {
  line: number;
  endLine?: number;
  text: string;
  kind: "comment" | "reply" | "note";
  severity?: "info" | "warning" | "error" | "hint";
  sign?: string;
  highlight?: boolean;
}

const replySchema = z.object({ author: z.enum(["user", "agent"]), body: z.string() }).passthrough();
const commentSchema = z
  .object({
    id: z.string(),
    path: z.string(),
    startLine: z.number(),
    endLine: z.number(),
    body: z.string(),
    severity: z.string(),
    state: z.string(),
    resolvedBy: z.enum(["user", "agent"]).nullable().catch(null),
    acknowledgedAt: z.number().nullable().catch(null),
    replies: z.array(replySchema).catch([]),
  })
  .passthrough();
export type ReviewComment = z.infer<typeof commentSchema>;

const SEVERITY: Record<string, AnnotationItem["severity"]> = { blocker: "error", issue: "warning", suggestion: "info", note: "info" };
const clip = (text: string) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text);

/** What one comment shows, or nothing once it is settled. */
export function commentItems(comment: ReviewComment): AnnotationItem[] {
  const resolved = comment.state === "resolved";
  if (resolved && (comment.resolvedBy !== "agent" || comment.acknowledgedAt !== null)) return [];
  const severity = SEVERITY[comment.severity] ?? "info";
  const items: AnnotationItem[] = [
    {
      line: comment.startLine,
      ...(comment.endLine > comment.startLine ? { endLine: comment.endLine } : {}),
      text: clip(`${comment.state === "outdated" ? "(outdated) " : ""}${comment.body}`),
      kind: "comment",
      severity,
      sign: "●",
    },
  ];
  for (const reply of comment.replies) items.push({ line: comment.endLine, text: clip(`${reply.author === "agent" ? "Agent" : "You"}: ${reply.body}`), kind: "reply" });
  if (resolved) items.push({ line: comment.endLine, text: "Resolved by the agent; acknowledge it in Review Editor to clear it", kind: "note", severity: "hint" });
  return items;
}

export function localItems(comment: LocalComment): AnnotationItem[] {
  return [{ line: comment.startLine, ...(comment.endLine > comment.startLine ? { endLine: comment.endLine } : {}), text: clip(`${comment.body} (pending, :bb-comments-send)`), kind: "comment", severity: "info", sign: "●" }];
}

/** Absolute path -> items, for one environment. */
export type FileAnnotations = Map<string, AnnotationItem[]>;

export interface AnnotatorDeps {
  sdk(): Sdk;
  service: HelixService;
  store: Store;
  reviewEditorRunning(): Promise<boolean>;
  log(message: string): void;
}

const digest = (items: AnnotationItem[]) => createHash("sha1").update(JSON.stringify(items)).digest("hex");

export class Annotator {
  /** Per instance: path -> digest of what it has. */
  private readonly sent = new Map<string, Map<string, string>>();
  /** Per instance: the open-document count last seen (opening files re-sends). */
  private readonly documents = new Map<string, number>();
  /** Every refresh runs on this chain, one at a time. */
  private chain: Promise<void> = Promise.resolve();
  private fullQueued = false;

  constructor(private readonly deps: AnnotatorDeps) {}

  start(): void {
    // No timer: Review Editor calls commentsChanged after every comment write,
    // this plugin refreshes after its own, and connecting or opening files
    // re-sends everything.
    void this.refresh();
  }

  dispose(): void {
  }

  /** Instances that show annotations, by environment. */
  private targets(): Map<string, BoundInstance[]> {
    const out = new Map<string, BoundInstance[]>();
    for (const i of this.deps.service.bridge.list()) {
      if (i.summary.status !== "connected" || !i.summary.capabilities.includes("annotations") || !i.environmentId) continue;
      out.set(i.environmentId, [...(out.get(i.environmentId) ?? []), i]);
    }
    return out;
  }

  /** Instance list changed (connect, disconnect, documents opened). */
  onInstances(): void {
    let reopen = false;
    const live = new Set<string>();
    for (const i of this.deps.service.bridge.list()) {
      live.add(i.key);
      const docs = i.summary.documents;
      const before = this.documents.get(i.key);
      if (i.summary.status !== "connected") {
        this.sent.delete(i.key);
        this.documents.delete(i.key);
        continue;
      }
      if (before === undefined || docs > before) {
        // New connection, or files opened: re-send everything it may show.
        this.sent.delete(i.key);
        reopen = true;
      }
      this.documents.set(i.key, docs);
    }
    for (const key of [...this.sent.keys()]) if (!live.has(key)) this.sent.delete(key);
    if (reopen) void this.refresh();
  }

  /**
   * Re-read every comment and push what changed. Calls made before a queued
   * run starts share it; a call during a run queues one more, so a write that
   * lands mid-read is never missed.
   */
  refresh(): Promise<void> {
    if (this.fullQueued) return this.chain;
    this.fullQueued = true;
    return this.enqueue(() => {
      this.fullQueued = false;
      return this.refreshOnce();
    });
  }

  /** Review Editor changed a comment on one file (relative to the environment): re-send that file. */
  refreshFile(environmentId: string, path: string): Promise<void> {
    return this.enqueue(() => this.refreshFileOnce(environmentId, path));
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const run = this.chain.then(work).catch((error: unknown) => this.deps.log(`annotations refresh failed: ${String(error)}`));
    this.chain = run;
    return run;
  }

  private async refreshFileOnce(environmentId: string, path: string): Promise<void> {
    const instances = this.targets().get(environmentId);
    const root = instances?.[0]?.environmentPath;
    if (!instances || !root || isAbsolute(path)) return;
    const relative = normalize(path);
    if (relative === ".." || relative.startsWith(`..${sep}`)) return;
    const absolute = join(root, relative);
    const { comments } = await this.deps.sdk().plugins.callRpc({
      pluginId: REVIEW_EDITOR,
      method: "listComments",
      input: { environmentId, path: relative, states: ["open", "sent", "outdated", "resolved"] },
      outputSchema: z.object({ comments: z.array(commentSchema) }),
    });
    const items = comments.flatMap(commentItems);
    const threads = new Set(instances.map((i) => i.threadId).filter((t): t is string => Boolean(t)));
    for (const threadId of threads) for (const comment of this.deps.store.pendingComments(threadId)) if (comment.path === absolute) items.push(...localItems(comment));
    const capped = items.slice(0, 500);
    const hash = digest(capped);
    for (const instance of instances) {
      const sent = this.sent.get(instance.key) ?? new Map<string, string>();
      if (capped.length === 0 ? !sent.has(absolute) : sent.get(absolute) === hash) continue;
      await this.set(instance, absolute, capped);
      if (capped.length === 0) sent.delete(absolute);
      else sent.set(absolute, hash);
      this.sent.set(instance.key, sent);
    }
  }

  private async refreshOnce(): Promise<void> {
    const targets = this.targets();
    if (targets.size === 0) return;
    const review = await this.deps.reviewEditorRunning();
    for (const [environmentId, instances] of targets) {
      const files = await this.environmentAnnotations(environmentId, instances, review);
      for (const instance of instances) await this.push(instance, files);
    }
  }

  async environmentAnnotations(environmentId: string, instances: BoundInstance[], review: boolean): Promise<FileAnnotations> {
    const files: FileAnnotations = new Map();
    const root = instances[0]?.environmentPath ?? null;
    if (review && root) {
      const { comments } = await this.deps.sdk().plugins.callRpc({
        pluginId: REVIEW_EDITOR,
        method: "listComments",
        input: { environmentId, states: ["open", "sent", "outdated", "resolved"] },
        outputSchema: z.object({ comments: z.array(commentSchema) }),
      });
      for (const comment of comments) {
        const items = commentItems(comment);
        if (items.length === 0) continue;
        const path = join(root, comment.path);
        files.set(path, [...(files.get(path) ?? []), ...items]);
      }
    }
    // This plugin's own pending comments (Review Editor absent, or a file outside it).
    const threads = new Set(instances.map((i) => i.threadId).filter((t): t is string => Boolean(t)));
    for (const threadId of threads) {
      for (const comment of this.deps.store.pendingComments(threadId)) files.set(comment.path, [...(files.get(comment.path) ?? []), ...localItems(comment)]);
    }
    for (const [path, items] of files) files.set(path, items.slice(0, 500));
    return files;
  }

  private async push(instance: BoundInstance, files: FileAnnotations): Promise<void> {
    const had = this.sent.get(instance.key) ?? new Map<string, string>();
    const next = new Map<string, string>();
    for (const [path, items] of files) {
      const hash = digest(items);
      next.set(path, hash);
      if (had.get(path) === hash) continue;
      await this.set(instance, path, items);
    }
    // Files whose comments all settled: clear them.
    for (const path of had.keys()) if (!files.has(path)) await this.set(instance, path, []);
    this.sent.set(instance.key, next);
  }

  private async set(instance: BoundInstance, path: string, items: AnnotationItem[]): Promise<void> {
    try {
      await this.deps.service.bridge.call(instance.key, "annotations/set", { namespace: NAMESPACE, path, items });
    } catch (error) {
      this.deps.log(`annotations/set on ${instance.key} for ${path} failed: ${String(error)}`);
    }
  }
}
