// The Review Editor RPC contract. app.tsx imports only its type; the CLI and
// agent tools call the same service functions the handlers do.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { COMMENT_STATES, SEVERITIES, isRelativePath } from "./shared";
import { readTags } from "./tags";

export { COMMENT_STATES, SEVERITIES, isRelativePath } from "./shared";

// ---------------------------------------------------------------------------
// Boundary schemas. Every id, path and ref from a client, the CLI, an agent
// or thread metadata passes through one of these before it is used.

export const ENVIRONMENT_ID = /^[A-Za-z0-9_-]{1,64}$/u;
export const THREAD_ID = /^[A-Za-z0-9_-]{1,64}$/u;
export const HOST_ID = /^[A-Za-z0-9_-]{1,64}$/u;
export const COMMENT_ID = /^rc_[a-z0-9]{10}$/u;

export const environmentIdSchema = z.string().regex(ENVIRONMENT_ID, "Invalid environment id");
export const threadIdSchema = z.string().regex(THREAD_ID, "Invalid thread id");
export const hostIdSchema = z.string().regex(HOST_ID, "Invalid host id");
export const commentIdSchema = z.string().regex(COMMENT_ID, "Invalid comment id");

/** A path relative to the environment's workspace root, `/`-separated. */
export const relativePathSchema = z
  .string()
  .refine(isRelativePath, "Path must be relative to the workspace, without `..` or `./`");

/** A git revision such as HEAD, a branch, a sha, or HEAD~1. Never an option. */
export const gitRefSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9._/~^@{}-]*$/u, "Invalid git ref");

export const fileRefSchema = z
  .object({ environmentId: environmentIdSchema, path: relativePathSchema })
  .strict();
export type FileRef = z.infer<typeof fileRefSchema>;

export const severitySchema = z.enum(SEVERITIES);
export type Severity = z.infer<typeof severitySchema>;

export const commentStateSchema = z.enum(COMMENT_STATES);
export type CommentState = z.infer<typeof commentStateSchema>;

export const commentBodySchema = z.string().trim().min(1).max(20_000);
export const replyBodySchema = z.string().trim().min(1).max(20_000);

// ---------------------------------------------------------------------------
// Output shapes.

export const replySchema = z.object({
  id: z.number().int(),
  author: z.enum(["user", "agent"]),
  /** The thread an agent replied from; null for the user. */
  threadId: z.string().nullable(),
  body: z.string(),
  createdAt: z.number(),
});
export type Reply = z.infer<typeof replySchema>;

export const commentSchema = z.object({
  id: z.string(),
  environmentId: z.string(),
  /** The thread the editor was opened from when the comment was written. */
  threadId: z.string().nullable(),
  path: z.string(),
  startLine: z.number().int(),
  endLine: z.number().int(),
  /** The quoted code. For an outdated comment, the code as it last was. */
  snippet: z.string(),
  /** sha256 of the file content the range and snippet refer to. */
  fileSha256: z.string(),
  body: z.string(),
  severity: severitySchema,
  state: commentStateSchema,
  /** The thread the comment was last sent to; kept when it goes outdated or resolved. */
  sentThreadId: z.string().nullable(),
  sentAt: z.number().nullable(),
  resolvedAt: z.number().nullable(),
  resolvedBy: z.enum(["user", "agent"]).nullable(),
  /** When the reviewer saw an agent's resolution; null while it waits for them. */
  acknowledgedAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  replies: z.array(replySchema),
});
export type Comment = z.infer<typeof commentSchema>;

const fileMeta = {
  environmentId: z.string(),
  path: z.string(),
  absolutePath: z.string(),
  hostId: z.string(),
};

export const fileReadSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("text"),
    ...fileMeta,
    content: z.string(),
    sha256: z.string(),
    sizeBytes: z.number(),
    modifiedAtMs: z.number().nullable(),
    lineCount: z.number().int(),
  }),
  z.object({
    status: z.enum(["binary", "too_large"]),
    ...fileMeta,
    sha256: z.string(),
    sizeBytes: z.number(),
  }),
  z.object({ status: z.literal("missing"), ...fileMeta }),
]);
export type FileRead = z.infer<typeof fileReadSchema>;

export const baseReadSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("text"),
    ref: z.string(),
    path: z.string(),
    content: z.string(),
    sha256: z.string(),
  }),
  z.object({ status: z.enum(["binary", "too_large"]), ref: z.string(), path: z.string() }),
  /** The file does not exist at that ref (added or untracked). */
  z.object({ status: z.literal("missing"), ref: z.string(), path: z.string() }),
  /** The environment is not a git repository. */
  z.object({ status: z.literal("not_git"), ref: z.string(), path: z.string() }),
]);
export type BaseRead = z.infer<typeof baseReadSchema>;

export const saveResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("saved"), sha256: z.string(), sizeBytes: z.number() }),
  /** The file changed since it was read; currentSha256 is null when it was deleted. */
  z.object({ outcome: z.literal("conflict"), currentSha256: z.string().nullable() }),
]);
export type SaveResult = z.infer<typeof saveResultSchema>;

export const gitTargetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("uncommitted") }).strict(),
  z.object({ type: z.enum(["branch_committed", "all"]), mergeBaseBranch: z.string().min(1).max(256) }).strict(),
  z.object({ type: z.literal("commit"), sha: z.string().regex(/^[0-9a-f]{4,64}$/u) }).strict(),
]);
export type GitTarget = z.infer<typeof gitTargetSchema>;

export const commentCountsSchema = z.object({
  open: z.number().int(),
  sent: z.number().int(),
  resolved: z.number().int(),
  outdated: z.number().int(),
});
export type CommentCounts = z.infer<typeof commentCountsSchema>;

export const changedFileSchema = z.object({
  path: z.string(),
  previousPath: z.string().nullable(),
  changeKind: z.string(),
  additions: z.number(),
  deletions: z.number(),
  binary: z.boolean(),
  origin: z.string(),
  revision: z.string(),
  comments: commentCountsSchema,
});
export type ChangedFile = z.infer<typeof changedFileSchema>;

export const changedFilesSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("available"),
    files: z.array(changedFileSchema),
    truncated: z.boolean(),
    shortstat: z.string(),
    mergeBaseRef: z.string().nullable(),
    /** Files with comments that git does not list as changed. */
    commentedFiles: z.array(z.object({ path: z.string(), comments: commentCountsSchema })),
  }),
  z.object({
    outcome: z.enum(["not_git", "unavailable"]),
    message: z.string(),
    commentedFiles: z.array(z.object({ path: z.string(), comments: commentCountsSchema })),
  }),
]);
export type ChangedFiles = z.infer<typeof changedFilesSchema>;

export const syncResultSchema = z.object({
  checked: z.number().int(),
  moved: z.number().int(),
  outdated: z.number().int(),
  restored: z.number().int(),
});
export type SyncResult = z.infer<typeof syncResultSchema>;

export const compiledPromptSchema = z.object({
  prompt: z.string(),
  commentIds: z.array(z.string()),
  fileCount: z.number().int(),
});
export type CompiledPrompt = z.infer<typeof compiledPromptSchema>;

// ---------------------------------------------------------------------------
// Thread plugin metadata written when comments are sent. Untrusted on read:
// anyone, including the thread's own agent, can write this namespace.

export const reviewMetadataSchema = z.object({
  version: z.literal(1),
  environmentId: environmentIdSchema,
  commentIds: z.array(commentIdSchema).max(200),
  sentAt: z.number(),
});
export type ReviewMetadata = z.infer<typeof reviewMetadataSchema>;

export { tags } from "./tags";

const listCommentsInput = z
  .object({
    environmentId: environmentIdSchema.optional(),
    path: relativePathSchema.optional(),
    /** Comments last sent to this thread. */
    sentThreadId: threadIdSchema.optional(),
    states: z.array(commentStateSchema).min(1).max(4).optional(),
  })
  .strict()
  .refine((input) => input.environmentId !== undefined || input.sentThreadId !== undefined, {
    message: "Pass environmentId or sentThreadId",
  })
  .refine((input) => input.path === undefined || input.environmentId !== undefined, {
    message: "path requires environmentId",
  });

export const rpcContract = defineRpcContract({
  // ----- files ------------------------------------------------------------
  resolveHostFile: {
    experimental_description:
      "Map an absolute path on a host to the environment whose workspace contains it, or null.",
    input: z.object({ hostId: hostIdSchema, path: z.string().min(1).max(4096) }).strict(),
    output: fileRefSchema.nullable(),
  },
  readFile: {
    experimental_description:
      "Read a workspace file through bb.sdk.files on its environment's host. Re-anchors its comments.",
    input: fileRefSchema,
    output: fileReadSchema,
    tags: readTags.readFile,
  },
  readBase: {
    experimental_description: "Read a file at a git ref (HEAD by default), for diffs.",
    input: fileRefSchema
      .extend({ ref: gitRefSchema.optional(), basePath: relativePathSchema.optional() })
      .strict(),
    output: baseReadSchema,
    tags: readTags.readBase,
  },
  saveFile: {
    experimental_description:
      "Save with a sha256 compare-and-swap guard. Returns conflict instead of overwriting.",
    input: fileRefSchema
      .extend({
        content: z.string().max(25_000_000),
        /** sha256 of the content the edit started from; null to create a new file only. */
        expectedSha256: z.string().regex(/^[0-9a-f]{64}$/u).nullable(),
      })
      .strict(),
    output: saveResultSchema,
  },
  changedFiles: {
    experimental_description: "Changed files from bb--git with each file's comment counts.",
    input: z
      .object({ environmentId: environmentIdSchema, target: gitTargetSchema.optional() })
      .strict(),
    output: changedFilesSchema,
    tags: readTags.changedFiles,
  },

  // ----- comments ---------------------------------------------------------
  listComments: {
    experimental_description: "Comments by environment (optionally one file) or by the thread they were sent to, with replies.",
    input: listCommentsInput,
    output: z.object({ comments: z.array(commentSchema) }),
    tags: readTags.listComments,
  },
  getComment: {
    experimental_description: "One comment with its replies.",
    input: z.object({ id: commentIdSchema }).strict(),
    output: commentSchema,
    tags: readTags.getComment,
  },
  createComment: {
    experimental_description:
      "Comment on a line range. The server reads the file to quote the snippet; pass the sha you see to refuse a stale range.",
    input: fileRefSchema
      .extend({
        /** A client-generated id (rc_ + 10 chars) so the UI can show the comment before the server answers. */
        id: commentIdSchema.optional(),
        startLine: z.number().int().min(1),
        endLine: z.number().int().min(1),
        body: commentBodySchema,
        severity: severitySchema.optional(),
        threadId: threadIdSchema.nullable().optional(),
        /** sha256 of the content the user selected lines in; conflict when the file moved on. */
        fileSha256: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
      })
      .strict()
      .refine((input) => input.endLine >= input.startLine, {
        message: "endLine must be at least startLine",
      }),
    output: commentSchema,
  },
  updateComment: {
    experimental_description: "Edit a comment's body or severity.",
    input: z
      .object({ id: commentIdSchema, body: commentBodySchema.optional(), severity: severitySchema.optional() })
      .strict(),
    output: commentSchema,
  },
  deleteComment: {
    experimental_description: "Delete a comment and its replies.",
    input: z.object({ id: commentIdSchema }).strict(),
    output: z.object({ deleted: z.boolean() }),
  },
  setCommentState: {
    experimental_description: "Resolve a comment, or reopen a resolved one.",
    input: z.object({ id: commentIdSchema, state: z.enum(["open", "resolved"]) }).strict(),
    output: commentSchema,
  },
  acknowledgeComments: {
    experimental_description: "Acknowledge agent resolutions the reviewer has seen, so they leave the margin.",
    input: z.object({ ids: z.array(commentIdSchema).min(1).max(200) }).strict(),
    output: z.object({ acknowledged: z.array(z.string()) }),
  },
  helixStatus: {
    experimental_description: "Whether Helix Bridge has a Helix open for this workspace (for Open in Helix).",
    input: z.object({ environmentId: environmentIdSchema, threadId: threadIdSchema.optional() }).strict(),
    output: z.object({ available: z.boolean() }),
  },
  openInHelix: {
    experimental_description: "Open a changed file in the Helix serving this workspace, with a review of the uncommitted changes active.",
    input: z.object({ environmentId: environmentIdSchema, threadId: threadIdSchema.optional(), path: relativePathSchema }).strict(),
    output: z.object({ opened: z.boolean(), message: z.string() }),
  },
  replyToComment: {
    experimental_description: "Reply to a comment as the user.",
    input: z.object({ commentId: commentIdSchema, body: replyBodySchema }).strict(),
    output: commentSchema,
  },
  syncAnchors: {
    experimental_description: "Re-read a file and move or outdate its comments now.",
    input: fileRefSchema,
    output: syncResultSchema,
  },

  // ----- handoff ----------------------------------------------------------
  compilePrompt: {
    experimental_description:
      "The prompt that hands comments to an agent: paths, ranges, quoted code, comments, and how to reply.",
    input: z
      .object({ commentIds: z.array(commentIdSchema).min(1).max(100) })
      .strict(),
    output: compiledPromptSchema,
  },
  markSent: {
    experimental_description:
      "Record that comments were handed to a thread (after the UI sent or inserted the prompt).",
    input: z
      .object({ commentIds: z.array(commentIdSchema).min(1).max(100), threadId: threadIdSchema })
      .strict(),
    output: z.object({ comments: z.array(commentSchema) }),
  },
  sendToThread: {
    experimental_description: "Compile, send to a thread with threads.send, and mark sent, in one call.",
    input: z
      .object({ commentIds: z.array(commentIdSchema).min(1).max(100), threadId: threadIdSchema })
      .strict(),
    output: z.object({ prompt: z.string(), comments: z.array(commentSchema) }),
  },
});

export type RpcContract = typeof rpcContract;
