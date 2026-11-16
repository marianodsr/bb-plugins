// Everything the RPC handlers, the CLI and the agent tools do. Each write
// invalidates the tags of the reads it changes, so every client refreshes
// once whichever surface made the change.
import { posix } from "node:path";
import { experimental_PluginRpcRefusal, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { reanchor, snippetFor, splitLines } from "./anchor";
import {
  reviewMetadataSchema,
  tags,
  type BaseRead,
  type ChangedFiles,
  type Comment,
  type CommentCounts,
  type CommentState,
  type CompiledPrompt,
  type FileRead,
  type FileRef,
  type GitTarget,
  type ReviewMetadata,
  type SaveResult,
  type Severity,
  type SyncResult,
} from "./contract";
import { compilePrompt, type PromptWorkspace } from "./prompt";
import type { CommentFilter, Store } from "./store";

type Sdk = BbPluginApi["sdk"];

/** Text files above this are opened read-only by the UI and never anchored. */
export const MAX_TEXT_BYTES = 5_000_000;
const ENVIRONMENT_TTL_MS = 30_000;
/** The file sha recorded against a deleted file. */
const MISSING_SHA = "missing";

export interface Workspace {
  environmentId: string;
  hostId: string;
  root: string;
  isGitRepo: boolean;
  branch: string | null;
}

export interface ResolvedFile extends Workspace {
  path: string;
  absolutePath: string;
}

export interface ServiceDeps {
  sdk: () => Sdk;
  store: Store;
  invalidate: (tags: readonly string[]) => void;
  log: (message: string) => void;
  now?: () => number;
}

export function refuse(code: "conflict" | "forbidden" | "invalid" | "not_found", message: string): never {
  throw new experimental_PluginRpcRefusal({ code, message });
}

function errorStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.message} ${(error as { code?: unknown }).code ?? ""}`;
  return String(error);
}

/** files.read rejects for a missing file; tell that apart from other failures. */
export function isMissingFileError(error: unknown): boolean {
  return errorStatus(error) === 404 || /ENOENT|not[ _-]?found|no such file|does not exist/iu.test(errorText(error));
}

/** Join a validated relative path onto a workspace root. */
export function joinWorkspace(root: string, path: string): string {
  const absolute = posix.join(root, path);
  const prefix = root.endsWith("/") ? root : `${root}/`;
  if (!absolute.startsWith(prefix)) refuse("invalid", "Path escapes the workspace");
  return absolute;
}

// bb--git `files`, copied down to the fields this plugin reads.
const gitFilesSchema = z.union([
  z.object({
    outcome: z.literal("available"),
    files: z.array(
      z.object({
        path: z.string(),
        previousPath: z.string().nullable(),
        changeKind: z.string(),
        additions: z.number(),
        deletions: z.number(),
        binary: z.boolean(),
        origin: z.string(),
        revision: z.string(),
      }),
    ),
    truncated: z.boolean(),
    shortstat: z.string(),
    mergeBaseRef: z.string().nullable(),
  }),
  z.object({ outcome: z.literal("not_applicable"), message: z.string() }),
  z.object({ outcome: z.literal("unavailable"), failure: z.object({ message: z.string() }) }),
]);

const EMPTY_COUNTS: CommentCounts = { open: 0, sent: 0, resolved: 0, outdated: 0 };

export class ReviewService {
  private readonly environments = new Map<string, { at: number; workspace: Workspace }>();
  private readonly now: () => number;

  constructor(private readonly deps: ServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  private get sdk(): Sdk {
    return this.deps.sdk();
  }

  // ----- environments and paths ------------------------------------------

  async workspace(environmentId: string): Promise<Workspace> {
    const cached = this.environments.get(environmentId);
    if (cached !== undefined && this.now() - cached.at < ENVIRONMENT_TTL_MS) return cached.workspace;
    let environment;
    try {
      environment = await this.sdk.environments.get({ environmentId });
    } catch (error) {
      if (errorStatus(error) === 404) refuse("not_found", `No environment ${environmentId}`);
      throw error;
    }
    if (environment.path === null) {
      refuse("not_found", `Environment ${environmentId} has no workspace on disk yet`);
    }
    const workspace: Workspace = {
      environmentId,
      hostId: environment.hostId,
      root: environment.path,
      isGitRepo: environment.isGitRepo,
      branch: environment.branchName,
    };
    this.environments.set(environmentId, { at: this.now(), workspace });
    return workspace;
  }

  forgetEnvironment(environmentId: string): void {
    this.environments.delete(environmentId);
  }

  async resolve(file: FileRef): Promise<ResolvedFile> {
    const workspace = await this.workspace(file.environmentId);
    return { ...workspace, path: file.path, absolutePath: joinWorkspace(workspace.root, file.path) };
  }

  /** The environment whose workspace holds an absolute host path, deepest root first. */
  async resolveHostFile(hostId: string, absolutePath: string): Promise<FileRef | null> {
    if (!absolutePath.startsWith("/")) return null;
    const normalized = posix.normalize(absolutePath);
    const environments = await this.sdk.environments.list({ hostId });
    const candidates = environments
      .filter((environment) => environment.path !== null && environment.hostId === hostId)
      .sort((a, b) => b.path!.length - a.path!.length);
    for (const environment of candidates) {
      const root = environment.path!.replace(/\/+$/u, "");
      if (normalized.startsWith(`${root}/`)) {
        return { environmentId: environment.id, path: normalized.slice(root.length + 1) };
      }
    }
    return null;
  }

  // ----- files --------------------------------------------------------------

  async readFile(file: FileRef): Promise<FileRead> {
    const resolved = await this.resolve(file);
    const meta = {
      environmentId: resolved.environmentId,
      path: resolved.path,
      absolutePath: resolved.absolutePath,
      hostId: resolved.hostId,
    };
    let read;
    try {
      read = await this.sdk.files.read({
        hostId: resolved.hostId,
        path: resolved.absolutePath,
        rootPath: resolved.root,
      });
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
      this.syncContent(resolved.environmentId, resolved.path, "", MISSING_SHA);
      return { status: "missing", ...meta };
    }
    if (!("content" in read)) refuse("conflict", "The host returned no content for this file");
    if (read.contentEncoding !== "utf8") {
      return { status: "binary", ...meta, sha256: read.sha256, sizeBytes: read.sizeBytes };
    }
    if (read.sizeBytes > MAX_TEXT_BYTES) {
      return { status: "too_large", ...meta, sha256: read.sha256, sizeBytes: read.sizeBytes };
    }
    this.syncContent(resolved.environmentId, resolved.path, read.content, read.sha256);
    return {
      status: "text",
      ...meta,
      content: read.content,
      sha256: read.sha256,
      sizeBytes: read.sizeBytes,
      modifiedAtMs: read.modifiedAtMs ?? null,
      lineCount: splitLines(read.content).length,
    };
  }

  async readBase(file: FileRef & { ref?: string; basePath?: string }): Promise<BaseRead> {
    const ref = file.ref ?? "HEAD";
    const path = file.basePath ?? file.path;
    const workspace = await this.workspace(file.environmentId);
    if (!workspace.isGitRepo) return { status: "not_git", ref, path };
    let read;
    try {
      read = await this.sdk.files.read({
        hostId: workspace.hostId,
        path: joinWorkspace(workspace.root, path),
        rootPath: workspace.root,
        ref,
      });
    } catch (error) {
      if (isMissingFileError(error)) return { status: "missing", ref, path };
      throw error;
    }
    if (!("content" in read)) return { status: "missing", ref, path };
    if (read.contentEncoding !== "utf8") return { status: "binary", ref, path };
    if (read.sizeBytes > MAX_TEXT_BYTES) return { status: "too_large", ref, path };
    return { status: "text", ref, path, content: read.content, sha256: read.sha256 };
  }

  async saveFile(file: FileRef & { content: string; expectedSha256: string | null }): Promise<SaveResult> {
    const resolved = await this.resolve(file);
    const written = await this.sdk.files.write({
      hostId: resolved.hostId,
      path: resolved.absolutePath,
      rootPath: resolved.root,
      content: file.content,
      expectedSha256: file.expectedSha256,
    });
    if (written.outcome === "conflict") {
      return { outcome: "conflict", currentSha256: written.currentSha256 };
    }
    this.syncContent(resolved.environmentId, resolved.path, file.content, written.sha256);
    this.deps.invalidate([tags.file(resolved.environmentId, resolved.path)]);
    return { outcome: "saved", sha256: written.sha256, sizeBytes: written.sizeBytes };
  }

  async changedFiles(environmentId: string, target: GitTarget = { type: "uncommitted" }): Promise<ChangedFiles> {
    const counts = this.deps.store.countsByPath(environmentId);
    const commented = (except: Set<string>) =>
      [...counts.entries()]
        .filter(([path]) => !except.has(path))
        .map(([path, comments]) => ({ path, comments }));
    const workspace = await this.workspace(environmentId);
    if (!workspace.isGitRepo) {
      return { outcome: "not_git", message: "This environment is not a git repository", commentedFiles: commented(new Set()) };
    }
    const result = await this.sdk.plugins.callRpc({
      pluginId: "bb--git",
      method: "files",
      input: { environmentId, target, ignoreWhitespace: false },
      outputSchema: gitFilesSchema,
    });
    if (result.outcome === "not_applicable") {
      return { outcome: "not_git", message: result.message, commentedFiles: commented(new Set()) };
    }
    if (result.outcome === "unavailable") {
      return { outcome: "unavailable", message: result.failure.message, commentedFiles: commented(new Set()) };
    }
    const files = result.files.map((entry) => ({ ...entry, comments: counts.get(entry.path) ?? EMPTY_COUNTS }));
    return {
      outcome: "available",
      files,
      truncated: result.truncated,
      shortstat: result.shortstat,
      mergeBaseRef: result.mergeBaseRef,
      commentedFiles: commented(new Set(files.map((entry) => entry.path))),
    };
  }

  // ----- anchoring ----------------------------------------------------------

  /**
   * Move or outdate the comments on one file against its current content.
   * Resolved comments move when their code is found but never go outdated.
   */
  syncContent(environmentId: string, path: string, content: string, sha256: string): SyncResult {
    const { store } = this.deps;
    const result: SyncResult = { checked: 0, moved: 0, outdated: 0, restored: 0 };
    if (Buffer.byteLength(content, "utf8") > MAX_TEXT_BYTES) return result;
    const stale = store.staleAnchors(environmentId, path, sha256);
    if (stale.length === 0) return result;
    const changed: Comment[] = [];
    store.transaction(() => {
      for (const comment of stale) {
        result.checked += 1;
        const previous = store.snapshot(comment.fileSha256);
        const found = reanchor(comment, content, previous);
        if (found.status === "found") {
          const state: CommentState =
            comment.state === "outdated" ? (comment.sentThreadId === null ? "open" : "sent") : comment.state;
          if (comment.state === "outdated") result.restored += 1;
          if (found.startLine !== comment.startLine || found.endLine !== comment.endLine) result.moved += 1;
          store.setAnchor(comment.id, { ...found, fileSha256: sha256, state });
          changed.push(comment);
        } else if (comment.state === "open" || comment.state === "sent") {
          // Keep the old range, snippet and file sha: a later version of the
          // file may bring the code back, and the snapshot stays referenced.
          store.setState(comment.id, "outdated");
          result.outdated += 1;
          changed.push(comment);
        }
      }
      if (changed.some((comment) => store.get(comment.id)?.fileSha256 === sha256)) {
        store.saveSnapshot(sha256, content);
      }
      store.collectSnapshots();
    });
    if (changed.length > 0) this.invalidateComments(changed);
    return result;
  }

  /** Re-read one file and sync its comments. */
  async syncFile(file: FileRef): Promise<SyncResult> {
    const resolved = await this.resolve(file);
    let read;
    try {
      read = await this.sdk.files.read({ hostId: resolved.hostId, path: resolved.absolutePath, rootPath: resolved.root });
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
      // A deleted file outdates every unresolved comment on it.
      return this.syncContent(file.environmentId, file.path, "", MISSING_SHA);
    }
    if (!("content" in read) || read.contentEncoding !== "utf8") {
      return { checked: 0, moved: 0, outdated: 0, restored: 0 };
    }
    return this.syncContent(file.environmentId, file.path, read.content, read.sha256);
  }

  /** Sync every file that has unresolved comments among these. Failures are logged, not thrown. */
  async syncComments(comments: readonly Comment[]): Promise<void> {
    const files = new Map<string, FileRef>();
    for (const comment of comments) {
      if (comment.state === "resolved") continue;
      files.set(`${comment.environmentId}\0${comment.path}`, { environmentId: comment.environmentId, path: comment.path });
    }
    await Promise.all(
      [...files.values()].slice(0, 50).map(async (file) => {
        try {
          await this.syncFile(file);
        } catch (error) {
          this.deps.log(`could not re-anchor ${file.path}: ${errorText(error)}`);
        }
      }),
    );
  }

  // ----- comments -----------------------------------------------------------

  private invalidateComments(comments: readonly Pick<Comment, "id" | "environmentId" | "sentThreadId">[], extraThreadIds: readonly string[] = []): void {
    const list = new Set<string>([tags.comments]);
    for (const comment of comments) {
      list.add(tags.envComments(comment.environmentId));
      list.add(tags.comment(comment.id));
      if (comment.sentThreadId !== null) list.add(tags.threadComments(comment.sentThreadId));
    }
    for (const threadId of extraThreadIds) list.add(tags.threadComments(threadId));
    this.deps.invalidate([...list]);
  }

  listComments(filter: CommentFilter): Comment[] {
    return this.deps.store.list(filter);
  }

  getComment(id: string): Comment {
    return this.deps.store.get(id) ?? refuse("not_found", `No comment ${id}`);
  }

  async createComment(input: FileRef & {
    id?: string;
    startLine: number;
    endLine: number;
    body: string;
    severity?: Severity;
    threadId?: string | null;
    fileSha256?: string;
  }): Promise<Comment> {
    if (input.id !== undefined && this.deps.store.get(input.id) !== null) {
      refuse("conflict", `Comment ${input.id} already exists`);
    }
    const file = await this.readFile({ environmentId: input.environmentId, path: input.path });
    if (file.status !== "text") {
      refuse("invalid", file.status === "missing" ? `${input.path} does not exist` : `${input.path} is not an editable text file`);
    }
    if (input.fileSha256 !== undefined && input.fileSha256 !== file.sha256) {
      refuse("conflict", "The file changed since those lines were selected; reload it and select again");
    }
    const snippet = snippetFor(splitLines(file.content), input.startLine, input.endLine);
    if (snippet === null) {
      refuse("invalid", `Lines ${input.startLine}-${input.endLine} are outside the file (it has ${file.lineCount} lines)`);
    }
    const { store } = this.deps;
    const comment = store.transaction(() => {
      store.saveSnapshot(file.sha256, file.content);
      return store.create({
        ...(input.id === undefined ? {} : { id: input.id }),
        environmentId: input.environmentId,
        threadId: input.threadId ?? null,
        path: input.path,
        startLine: input.startLine,
        endLine: input.endLine,
        snippet,
        fileSha256: file.sha256,
        body: input.body,
        severity: input.severity ?? "note",
      });
    });
    this.invalidateComments([comment]);
    return comment;
  }

  updateComment(id: string, patch: { body?: string; severity?: Severity }): Comment {
    this.getComment(id);
    const comment = this.deps.store.update(id, patch)!;
    this.invalidateComments([comment]);
    return comment;
  }

  deleteComment(id: string): boolean {
    const comment = this.deps.store.get(id);
    if (comment === null) return false;
    this.deps.store.delete(id);
    this.invalidateComments([comment]);
    return true;
  }

  setState(id: string, state: "open" | "resolved", by: "user" | "agent" = "user"): Comment {
    const current = this.getComment(id);
    let comment: Comment;
    if (state === "resolved") {
      comment = current.state === "resolved" ? current : this.deps.store.resolve(id, by)!;
    } else {
      if (current.state !== "resolved") return current;
      comment = this.deps.store.reopen(id)!;
    }
    this.invalidateComments([comment]);
    return comment;
  }

  acknowledge(ids: readonly string[]): string[] {
    const changed = this.deps.store.acknowledge([...new Set(ids)]);
    if (changed.length > 0) this.invalidateComments(this.deps.store.list({ ids: changed }));
    return changed;
  }

  reply(commentId: string, body: string, author: "user" | "agent", threadId: string | null): Comment {
    this.getComment(commentId);
    this.deps.store.addReply(commentId, author, body, threadId);
    const comment = this.getComment(commentId);
    this.invalidateComments([comment]);
    return comment;
  }

  // ----- agent access -------------------------------------------------------

  /** A comment an agent in `threadId` may act on: it must have been sent there. */
  agentComment(commentId: string, threadId: string): Comment {
    const comment = this.deps.store.get(commentId);
    if (comment === null) refuse("not_found", `No comment ${commentId}`);
    if (comment.sentThreadId !== threadId) {
      refuse("forbidden", `Comment ${commentId} was not sent to this thread`);
    }
    return comment;
  }

  // ----- handoff ------------------------------------------------------------

  private commentsByIds(ids: readonly string[]): Comment[] {
    const unique = [...new Set(ids)];
    const comments = this.deps.store.list({ ids: unique });
    const missing = unique.filter((id) => !comments.some((comment) => comment.id === id));
    if (missing.length > 0) refuse("not_found", `No comment ${missing.join(", ")}`);
    return comments;
  }

  async compile(ids: readonly string[]): Promise<CompiledPrompt> {
    const comments = this.commentsByIds(ids);
    await this.syncComments(comments);
    const current = this.commentsByIds(ids);
    const workspaces: PromptWorkspace[] = [];
    for (const environmentId of new Set(current.map((comment) => comment.environmentId))) {
      try {
        const workspace = await this.workspace(environmentId);
        workspaces.push({ environmentId, root: workspace.root, branch: workspace.branch });
      } catch {
        workspaces.push({ environmentId, root: null, branch: null });
      }
    }
    return {
      prompt: compilePrompt(current, workspaces),
      commentIds: current.map((comment) => comment.id),
      fileCount: new Set(current.map((comment) => `${comment.environmentId}\0${comment.path}`)).size,
    };
  }

  async markSent(ids: readonly string[], threadId: string): Promise<Comment[]> {
    const before = this.commentsByIds(ids);
    try {
      await this.sdk.threads.get({ threadId });
    } catch (error) {
      if (errorStatus(error) === 404) refuse("not_found", `No thread ${threadId}`);
      throw error;
    }
    this.deps.store.markSent(before.map((comment) => comment.id), threadId);
    const after = this.commentsByIds(ids);
    // Earlier recipients lose these comments; refresh their lists too.
    this.invalidateComments([...before, ...after], [threadId]);
    const environmentId = after[0]!.environmentId;
    const metadata: ReviewMetadata = {
      version: 1,
      environmentId,
      commentIds: after.map((comment) => comment.id).slice(0, 200),
      sentAt: this.now(),
    };
    try {
      await this.sdk.threads.updatePluginMetadata({ threadId, set: { review: metadata } });
    } catch (error) {
      this.deps.log(`could not write thread metadata for ${threadId}: ${errorText(error)}`);
    }
    return after;
  }

  async sendToThread(ids: readonly string[], threadId: string): Promise<{ prompt: string; comments: Comment[] }> {
    const { prompt } = await this.compile(ids);
    await this.sdk.threads.send({
      threadId,
      mode: "auto",
      input: [{ type: "text", text: prompt, mentions: [] }],
    });
    const comments = await this.markSent(ids, threadId);
    return { prompt, comments };
  }

  /**
   * How many unresolved comments a thread holds, for its agent instructions.
   * The database is the authority; metadata only covers the moment between a
   * new thread's spawn and markSent, and only counts comments that exist.
   */
  unresolvedForThread(threadId: string, pluginMetadata: unknown): number {
    const sent = this.deps.store.unresolvedSentCount(threadId);
    if (sent > 0) return sent;
    const review = (pluginMetadata as { review?: unknown } | null)?.review;
    const parsed = reviewMetadataSchema.safeParse(review);
    if (!parsed.success) return 0;
    return this.deps.store.unresolvedCount(parsed.data.commentIds, threadId);
  }
}
