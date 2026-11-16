// The RPC contract. The frontend imports only `typeof rpcContract`.
//
// Reads are cache-first and declare tags; the server invalidates those tags
// when a refresh, CLI command or agent tool changes the data, so every open
// client refetches once. Lists tag every issue they show, so a change to one
// issue refreshes every read that displays it.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  failureSchema,
  issueKeySchema,
  issueResultSchema,
  issueRowSchema,
  issueSummarySchema,
  jqlSchema,
  listResultSchema,
  statusResultSchema,
  viewSchema,
} from "./schemas.js";
import { TAGS as TAG } from "./tags.js";


export const LIST_LIMIT_DEFAULT = 50;
export const LIST_LIMIT_MAX = 200;

const viewNameSchema = z.string().trim().min(1).max(80);
const threadIdSchema = z.string().trim().min(1).max(200);

export const listInputSchema = z
  .object({
    viewId: z.string().trim().min(1).max(64).optional(),
    jql: jqlSchema.optional(),
    limit: z.number().int().min(1).max(LIST_LIMIT_MAX).default(LIST_LIMIT_DEFAULT),
  })
  .strict()
  .refine((input) => (input.viewId === undefined) !== (input.jql === undefined), {
    message: "Pass exactly one of viewId or jql",
  });

export const rpcContract = defineRpcContract({
  /** Connection state for the setup screen and header. */
  status: {
    input: z.null(),
    output: statusResultSchema,
    tags: () => [TAG.status],
  },
  /** Verify credentials against Jira now. */
  checkConnection: {
    input: z.null(),
    output: statusResultSchema,
  },

  "views.list": {
    input: z.null(),
    output: z.object({ views: z.array(viewSchema) }),
    tags: () => [TAG.views],
  },
  "views.create": {
    input: z.object({ name: viewNameSchema, jql: jqlSchema }).strict(),
    output: viewSchema,
  },
  "views.update": {
    input: z
      .object({
        id: z.string().trim().min(1).max(64),
        name: viewNameSchema.optional(),
        jql: jqlSchema.optional(),
      })
      .strict(),
    output: viewSchema,
  },
  "views.delete": {
    input: z.object({ id: z.string().trim().min(1).max(64) }).strict(),
    output: z.object({ removed: z.boolean() }),
  },
  "views.reorder": {
    input: z.object({ ids: z.array(z.string().min(1).max(64)).max(200) }).strict(),
    output: z.object({ views: z.array(viewSchema) }),
  },

  /**
   * Cache-first issue list for a saved view or ad-hoc JQL. Returns what is
   * cached at once and refreshes behind it when stale (`refreshing: true`);
   * with nothing cached it waits up to ~2.5 s for the first page. Raise
   * `limit` to load more.
   */
  "issues.list": {
    input: listInputSchema,
    output: listResultSchema,
    tags: (input, output) => [
      TAG.search(output.queryId),
      ...(input.viewId ? [TAG.views] : []),
      ...output.issues.map((issue) => TAG.issue(issue.key)),
    ],
  },
  /** Cache-first issue document. `row` paints first when only a row is cached. */
  "issue.get": {
    input: z.object({ key: issueKeySchema }).strict(),
    output: issueResultSchema,
    tags: ({ key }, output) => [
      TAG.issue(key),
      ...(output.issue && output.issue.key !== key ? [TAG.issue(output.issue.key)] : []),
    ],
  },
  /** The issue as bounded Markdown, for the handoff prompt. */
  "issue.context": {
    input: z.object({ key: issueKeySchema }).strict(),
    output: z.object({
      key: z.string(),
      markdown: z.string(),
      fetchedAt: z.number(),
      fromCache: z.boolean(),
    }),
    tags: ({ key }) => [TAG.issue(key)],
  },
  /**
   * Force a refresh and wait for it (the Refresh control). Exactly one of
   * viewId, jql or key.
   */
  refresh: {
    input: z
      .object({
        viewId: z.string().trim().min(1).max(64).optional(),
        jql: jqlSchema.optional(),
        key: issueKeySchema.optional(),
        limit: z.number().int().min(1).max(LIST_LIMIT_MAX).default(LIST_LIMIT_DEFAULT),
      })
      .strict()
      .refine(
        (input) =>
          [input.viewId, input.jql, input.key].filter((value) => value !== undefined).length === 1,
        { message: "Pass exactly one of viewId, jql or key" },
      ),
    output: z.object({ error: failureSchema.nullable() }),
  },

  /** Cross-plugin contract (PLAN.md): `{ key, summary, status, statusCategory, url }` or null. */
  issueSummary: {
    input: z.object({ key: issueKeySchema }).strict(),
    output: issueSummarySchema,
    tags: ({ key }) => [TAG.issue(key)],
  },

  /** Issues linked to a thread (the thread's Issue tab). */
  "thread.issues": {
    input: z.object({ threadId: threadIdSchema }).strict(),
    output: z.object({ keys: z.array(z.string()), issues: z.array(issueRowSchema) }),
    tags: ({ threadId }, output) => [
      TAG.thread(threadId),
      ...output.keys.map((key) => TAG.issue(key)),
    ],
  },
  "thread.link": {
    input: z.object({ threadId: threadIdSchema, key: issueKeySchema }).strict(),
    output: z.object({ linked: z.boolean() }),
  },
  "thread.unlink": {
    input: z.object({ threadId: threadIdSchema, key: issueKeySchema }).strict(),
    output: z.object({ removed: z.boolean() }),
  },

  /** Create a Task Board task from an issue through Task Board's `createTask`. */
  addToTaskBoard: {
    input: z
      .object({ key: issueKeySchema, projectId: z.string().trim().min(1).max(200).optional() })
      .strict(),
    output: z.object({ id: z.string(), route: z.string() }),
  },
});

export type RpcContract = typeof rpcContract;
