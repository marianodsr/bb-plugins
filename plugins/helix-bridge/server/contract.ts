// The RPC contract the app uses. Reads declare tags; the server invalidates
// `instances` when anything the app shows changes structurally (instances,
// bindings, status, focused file, counts). Cursor moves go over realtime
// (`position`), never through a bb write.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { dirListingSchema, fileOpResultSchema, fileOpSchema, filesListInputSchema, ghosttyConfigSchema } from "../shared/host-contract";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u);
const instanceKey = z.string().regex(/^[A-Za-z0-9_-]{1,64}:[A-Za-z0-9_-]{1,64}$/u);

export const tags = {
  instances: "instances",
  comments: (threadId: string) => `comments:${threadId}`,
  drafts: (threadId: string) => `drafts:${threadId}`,
  setup: "setup",
  review: (threadId: string) => `review:${threadId}`,
};

export const appInstanceSchema = z.object({
  key: z.string(),
  hostId: z.string(),
  pid: z.number().int(),
  status: z.string(),
  error: z.string().nullable(),
  helixVersion: z.string().nullable(),
  workspaceRoot: z.string().nullable(),
  threadId: z.string().nullable(),
  threadTitle: z.string().nullable(),
  bindingSource: z.enum(["terminal", "explicit", "environment"]).nullable(),
  terminalId: z.string().nullable(),
  /** Display path (relative to the workspace) and cursor of the focused buffer. */
  focus: z.object({ path: z.string().nullable(), absolutePath: z.string().nullable(), line: z.number().nullable(), col: z.number().nullable(), endLine: z.number().nullable(), modified: z.boolean() }).nullable(),
  mode: z.string().nullable(),
  diagnostics: z.object({ errors: z.number(), warnings: z.number() }),
  capabilities: z.array(z.string()),
  commandPolicy: z.string().nullable(),
  pendingSends: z.number(),
  skippedModified: z.array(z.string()),
});
export type AppInstance = z.infer<typeof appInstanceSchema>;

export const changedFileSchema = z.object({
  path: z.string(),
  previousPath: z.string().nullable(),
  status: z.enum(["added", "modified", "deleted", "renamed"]),
  additions: z.number(),
  deletions: z.number(),
  revision: z.string().nullable(),
  binary: z.boolean(),
  viewed: z.boolean(),
});
export type ChangedFile = z.infer<typeof changedFileSchema>;

export const railCommentSchema = z.object({
  id: z.string(),
  /** Relative to the workspace when it is in it. */
  path: z.string(),
  startLine: z.number(),
  endLine: z.number(),
  snippet: z.string(),
  body: z.string(),
  severity: z.string(),
  /** unsent, sent, answered (the agent replied), resolved (by the agent, waiting for you), done, outdated. */
  state: z.enum(["unsent", "sent", "answered", "resolved", "done", "outdated"]),
  replies: z.array(z.object({ author: z.enum(["user", "agent"]), body: z.string(), at: z.number() })),
  local: z.boolean(),
  updatedAt: z.number(),
});
export type RailComment = z.infer<typeof railCommentSchema>;

export const positionSchema = z.object({ key: z.string(), threadId: z.string().nullable(), path: z.string().nullable(), absolutePath: z.string().nullable(), line: z.number().nullable(), col: z.number().nullable(), endLine: z.number().nullable(), mode: z.string().nullable() });
export type Position = z.infer<typeof positionSchema>;

const draftSchema = z.object({ id: z.string(), threadId: z.string(), text: z.string(), summary: z.string(), createdAt: z.number() });

export const rpcContract = defineRpcContract({
  instances: {
    experimental_description: "Every Helix instance on every machine with its bound thread.",
    input: z.null(),
    output: z.object({ instances: z.array(appInstanceSchema), hosts: z.array(z.object({ hostId: z.string(), bridgeDir: z.string(), dirExists: z.boolean(), error: z.string().nullable(), instances: z.number() })) }),
    tags: () => [tags.instances],
  },
  threadStatus: {
    experimental_description: "The Helix serving a thread (bound to it, or in its environment), if any.",
    input: z.object({ threadId: id }).strict(),
    output: z.object({ instance: appInstanceSchema.nullable(), candidates: z.number() }),
    tags: () => [tags.instances],
  },
  reviewState: {
    experimental_description: "The review active in the Helix serving a thread, if any, with its open comments.",
    input: z.object({ threadId: id }).strict(),
    output: z.object({
      capable: z.boolean(),
      review: z.object({ id: z.string(), title: z.string(), target: z.string(), files: z.number(), additions: z.number(), deletions: z.number() }).nullable(),
      openComments: z.number(),
    }),
    tags: ({ threadId }) => [tags.review(threadId), tags.instances],
  },
  changes: {
    experimental_description: "The rail's Changes tab: the review active in the thread's Helix, its files with bb's viewed marks, and whether the thread has a pull request.",
    input: z.object({ threadId: id }).strict(),
    output: z.object({
      capable: z.boolean(),
      connected: z.boolean(),
      review: z
        .object({
          id: z.string(),
          title: z.string(),
          scope: z.enum(["uncommitted", "branch", "pr", "commit"]),
          sha: z.string().nullable(),
          files: z.array(changedFileSchema),
          truncated: z.boolean(),
          additions: z.number(),
          deletions: z.number(),
          inline: z.boolean().nullable(),
        })
        .nullable(),
      error: z.string().nullable(),
      hasPullRequest: z.boolean(),
      pullRequest: z.object({ number: z.number(), url: z.string().nullable() }).nullable(),
    }),
    tags: ({ threadId }) => [tags.review(threadId), tags.instances],
  },
  setViewed: {
    experimental_description: "Mark a file of the active review viewed (bb's Git viewed mark at its current revision) or not.",
    input: z.object({ threadId: id, path: z.string().min(1).max(4096), viewed: z.boolean() }).strict(),
    output: z.object({ ok: z.boolean() }),
  },
  filePatch: {
    experimental_description: "One file's patch in the active review, from bb's Git plugin, for the rail's flyout.",
    input: z.object({ threadId: id, path: z.string().min(1).max(4096), revision: z.string().min(1).max(1024) }).strict(),
    output: z.object({ patch: z.string().nullable(), truncated: z.boolean(), message: z.string().nullable() }),
  },
  openChange: {
    experimental_description: "Show a reviewed file in the thread's Helix at a line, or at its first change, and give Helix focus.",
    input: z.object({ threadId: id, path: z.string().min(1).max(4096), line: z.number().int().min(1).optional() }).strict(),
    output: z.object({ opened: z.boolean() }),
  },
  setInline: {
    experimental_description: "Turn the active review's inline diff in Helix on or off.",
    input: z.object({ threadId: id, inline: z.boolean() }).strict(),
    output: z.object({ ok: z.boolean() }),
  },
  recentCommits: {
    experimental_description: "The last commits on the thread's branch, for the rail's Commit scope (read when that scope opens).",
    input: z.object({ threadId: id }).strict(),
    output: z.object({ commits: z.array(z.object({ sha: z.string(), subject: z.string(), when: z.string() })) }),
  },
  comments: {
    experimental_description: "The thread's review comments for the rail's Comments tab: kept in Review Editor (or here when it is not running), with the agent's replies and what waits for the owner.",
    input: z.object({ threadId: id }).strict(),
    output: z.object({
      source: z.enum(["review-editor", "local"]),
      comments: z.array(railCommentSchema),
      unsent: z.number(),
      needsYou: z.number(),
    }),
    tags: ({ threadId }) => [tags.comments(threadId)],
  },
  createComment: {
    experimental_description: "Comment on lines from the editor's comment box; sendNow also sends every comment not sent yet.",
    input: z
      .object({
        threadId: id,
        path: z.string().min(1).max(4096),
        startLine: z.number().int().min(1),
        endLine: z.number().int().min(1),
        snippet: z.string().max(200_000),
        languageId: z.string().max(64),
        modified: z.boolean(),
        body: z.string().trim().min(1).max(20_000),
        severity: z.enum(["note", "suggestion", "issue", "blocker"]).optional(),
        sendNow: z.boolean().optional(),
      })
      .strict(),
    output: z.object({ id: z.string(), kept: z.enum(["review-editor", "local"]), message: z.string() }),
  },
  commentAction: {
    experimental_description: "Change one of the thread's comments: edit, drop, reply, reopen, resolve, or acknowledge the agent's resolution.",
    input: z
      .object({ threadId: id, commentId: z.string().min(1).max(64), action: z.enum(["edit", "delete", "reply", "reopen", "resolve", "acknowledge"]), body: z.string().trim().min(1).max(20_000).optional() })
      .strict(),
    output: z.object({ ok: z.boolean() }),
  },
  reviewSummaries: {
    experimental_description: "For thread headers and context cards: per thread, its active review's file count, how many are not viewed, and the comments waiting. No git: the review the server holds and bb's viewed marks.",
    input: z.object({ threadIds: z.array(id).max(50) }).strict(),
    output: z.record(z.string(), z.object({ files: z.number(), unviewed: z.number(), unsent: z.number(), needsYou: z.number(), title: z.string() })),
    tags: ({ threadIds }) => threadIds.flatMap((t) => [tags.review(t), tags.comments(t)]),
  },
  notifyHelix: {
    experimental_description: "Show one line on the status line of the thread's Helix (an action the page could not do).",
    input: z.object({ threadId: id, message: z.string().min(1).max(300) }).strict(),
    output: z.object({ ok: z.boolean() }),
  },
  startReview: {
    experimental_description: "Start a review in the thread's Helix: auto (the branch when it has its own commits, else uncommitted), uncommitted, branch, pr, commit <sha>, or off to end it.",
    input: z.object({ threadId: id, target: z.string().max(240) }).strict(),
    output: z.object({ message: z.string() }),
  },
  sendReviewComments: {
    experimental_description: "Send the thread's pending comments to its agent, naming the active review.",
    input: z.object({ threadId: id }).strict(),
    output: z.object({ message: z.string() }),
  },
  environmentStatus: {
    experimental_description: "Whether a connected Helix serves this environment, and whether it can review (Review Editor's Open in Helix).",
    input: z.object({ environmentId: id, threadId: id.optional() }).strict(),
    output: z.object({ serves: z.boolean(), review: z.boolean() }),
  },
  openInReview: {
    experimental_description: "Open a changed file in the Helix serving an environment, with a review active (Review Editor's changed-files list).",
    input: z.object({ environmentId: id, threadId: id.optional(), path: z.string().min(1).max(4096), target: z.string().max(240).optional() }).strict(),
    output: z.object({ opened: z.boolean(), message: z.string() }),
  },
  bind: {
    experimental_description: "Bind an instance to a thread.",
    input: z.object({ instanceKey, threadId: id }).strict(),
    output: appInstanceSchema,
  },
  unbind: {
    experimental_description: "Remove an instance's explicit binding.",
    input: z.object({ instanceKey }).strict(),
    output: appInstanceSchema,
  },
  reload: {
    experimental_description: "Reload an instance's buffers that changed on disk.",
    input: z.object({ instanceKey }).strict(),
    output: z.object({ reloaded: z.number(), skippedModified: z.array(z.string()) }),
  },
  drafts: {
    experimental_description: "Selections sent from Helix waiting to land in this thread's composer.",
    input: z.object({ threadId: id }).strict(),
    output: z.object({ drafts: z.array(draftSchema) }),
    tags: ({ threadId }) => [tags.drafts(threadId)],
  },
  takeDraft: {
    experimental_description: "Remove a draft once the app put it in the composer.",
    input: z.object({ id: z.string().regex(/^drf_[a-z0-9-]{1,32}$/u) }).strict(),
    output: z.object({ taken: z.boolean() }),
  },
  setup: {
    experimental_description: "Doctor checks for this bb's machine: binary, protocol, bridge directory, tools, font.",
    input: z.null(),
    output: z.object({ ready: z.boolean(), checks: z.array(z.object({ id: z.string(), label: z.string(), level: z.enum(["ok", "warn", "error"]), detail: z.string(), fix: z.string().nullable() })) }),
    tags: () => [tags.setup],
  },
  ghostty: {
    experimental_description: "The editor surface's look: the user's Ghostty config with this plugin's overrides.",
    input: z.object({ fontStyle: z.string().max(64).optional() }).strict().nullable(),
    output: ghosttyConfigSchema.extend({ hud: z.boolean() }),
  },
  commentsChanged: {
    experimental_description: "Review Editor wrote a comment on this file: re-send its annotations to Helix. Returns at once.",
    input: z.object({ environmentId: id, path: z.string().min(1).max(4096) }).strict(),
    output: z.object({ accepted: z.boolean() }),
  },
  treeTerminal: {
    experimental_description: "The thread's file tree session (yazi), started if needed; or what to install.",
    input: z.object({ threadId: id }).strict(),
    output: z.union([
      z.object({ terminalId: z.string(), created: z.boolean(), missing: z.null() }),
      z.object({ terminalId: z.null(), created: z.literal(false), missing: z.string() }),
    ]),
  },
  treeReveal: {
    experimental_description: "Show a file in the thread's tree.",
    input: z.object({ threadId: id, path: z.string().min(1).max(4096) }).strict(),
    output: z.object({ ok: z.boolean() }),
  },
  treeClose: {
    experimental_description: "Close the thread's tree (the editor closed).",
    input: z.object({ threadId: id }).strict(),
    output: z.object({ closed: z.boolean() }),
  },
  filesList: {
    experimental_description: "The file tree: these folders of the thread's workspace (\"\" is the workspace), read in one call, with the workspace's absolute path.",
    input: z.object({ threadId: id, dirs: filesListInputSchema }).strict(),
    output: z.object({ root: z.string(), dirs: z.record(z.string(), dirListingSchema) }),
  },
  filesOp: {
    experimental_description: "The file tree: create, rename, copy, move, trash or delete in the thread's workspace. Never replaces; errors come back as values.",
    input: z.object({ threadId: id, op: fileOpSchema }).strict(),
    output: fileOpResultSchema,
  },
  filesOpen: {
    experimental_description: "The file tree: open a file of the workspace in the thread's Helix, at once.",
    input: z.object({ threadId: id, path: z.string().min(1).max(4096) }).strict(),
    output: z.object({ ok: z.boolean(), error: z.string().nullable() }),
  },
  editorTerminal: {
    experimental_description: "The thread's Helix terminal session, started if needed.",
    input: z.object({ threadId: id }).strict(),
    output: z.object({ terminalId: z.string(), created: z.boolean() }),
  },
});
