// Wire shapes shared by the RPC contract, the CLI, tools and tests. Every type
// the UI sees is inferred from these schemas so the contract has one source.
import { z } from "zod";

/** Jira's three status categories, renamed for readers. Jira's `new` and its
 * rare `undefined` (No Category) both map to `todo`. */
export const statusCategorySchema = z.enum(["todo", "in_progress", "done"]);
export type StatusCategory = z.infer<typeof statusCategorySchema>;

export const personSchema = z.object({
  accountId: z.string().nullable(),
  displayName: z.string(),
});
export type Person = z.infer<typeof personSchema>;

/** One issue as a list row: enough to scan, group and flash on change. */
export const issueRowSchema = z.object({
  key: z.string(),
  id: z.string(),
  summary: z.string(),
  status: z.string(),
  statusCategory: statusCategorySchema,
  issueType: z.string().nullable(),
  priority: z.string().nullable(),
  assignee: personSchema.nullable(),
  projectKey: z.string().nullable(),
  projectName: z.string().nullable(),
  parentKey: z.string().nullable(),
  labels: z.array(z.string()),
  created: z.string().nullable(),
  updated: z.string().nullable(),
  url: z.string(),
});
export type IssueRow = z.infer<typeof issueRowSchema>;

/** A compact reference to a related issue (parent, subtask, link target). */
export const issueRefSchema = z.object({
  key: z.string(),
  summary: z.string(),
  status: z.string().nullable(),
  statusCategory: statusCategorySchema.nullable(),
  issueType: z.string().nullable(),
  url: z.string(),
});
export type IssueRef = z.infer<typeof issueRefSchema>;

export const issueLinkSchema = z.object({
  id: z.string(),
  /** The link type's name, such as "Blocks". */
  type: z.string(),
  direction: z.enum(["inward", "outward"]),
  /** How the link reads from this issue, such as "is blocked by". */
  label: z.string(),
  issue: issueRefSchema,
});
export type IssueLink = z.infer<typeof issueLinkSchema>;

export const commentSchema = z.object({
  id: z.string(),
  author: personSchema.nullable(),
  created: z.string().nullable(),
  updated: z.string().nullable(),
  /** Markdown converted from Atlassian Document Format. */
  body: z.string(),
});
export type Comment = z.infer<typeof commentSchema>;

export const attachmentSchema = z.object({
  id: z.string(),
  filename: z.string(),
  mimeType: z.string().nullable(),
  size: z.number().nullable(),
});
export type Attachment = z.infer<typeof attachmentSchema>;

/** The whole issue as a document. */
export const issueDocumentSchema = issueRowSchema.extend({
  /** Markdown converted from ADF; empty string when the issue has none. */
  description: z.string(),
  reporter: personSchema.nullable(),
  resolution: z.string().nullable(),
  dueDate: z.string().nullable(),
  components: z.array(z.string()),
  fixVersions: z.array(z.string()),
  parent: issueRefSchema.nullable(),
  subtasks: z.array(issueRefSchema),
  links: z.array(issueLinkSchema),
  /** Newest last, at most the latest 50. */
  comments: z.array(commentSchema),
  /** How many comments the issue has in Jira, which can exceed `comments`. */
  commentsTotal: z.number(),
  attachments: z.array(attachmentSchema),
});
export type IssueDocument = z.infer<typeof issueDocumentSchema>;

/**
 * Every way talking to Jira can fail, as a state the UI can explain.
 * `retryAfterMs` is set for `rate_limited` (from Retry-After).
 */
export const failureKindSchema = z.enum([
  "not_configured",
  "unauthorized",
  "forbidden",
  "not_found",
  "rate_limited",
  "bad_request",
  "timeout",
  "network",
  "server",
  "invalid_response",
]);
export type FailureKind = z.infer<typeof failureKindSchema>;

export const failureSchema = z.object({
  kind: failureKindSchema,
  message: z.string(),
  status: z.number().nullable(),
  retryAfterMs: z.number().nullable(),
  at: z.number(),
});
export type Failure = z.infer<typeof failureSchema>;

export const viewSchema = z.object({
  id: z.string(),
  name: z.string(),
  jql: z.string(),
  position: z.number(),
  /** Seeded default view. The user can still rename or delete it. */
  builtin: z.boolean(),
});
export type View = z.infer<typeof viewSchema>;

/** Freshness facts shared by every cache-first read. */
export const freshnessShape = {
  /** When the data was last fetched from Jira (epoch ms), or null if never. */
  fetchedAt: z.number().nullable(),
  /** True when the data is older than its refresh interval. */
  stale: z.boolean(),
  /** True while a refresh for this read is in flight. */
  refreshing: z.boolean(),
  /** The last refresh failure, kept until a refresh succeeds. */
  error: failureSchema.nullable(),
};

export const listResultSchema = z.object({
  /** Stable id for the query (hash of its JQL). */
  queryId: z.string(),
  viewId: z.string().nullable(),
  jql: z.string(),
  issues: z.array(issueRowSchema),
  /** Jira has more matches than `issues` holds. */
  hasMore: z.boolean(),
  ...freshnessShape,
});
export type ListResult = z.infer<typeof listResultSchema>;

export const issueResultSchema = z.object({
  key: z.string(),
  issue: issueDocumentSchema.nullable(),
  /** A list row for the key when only that is cached (paint it first). */
  row: issueRowSchema.nullable(),
  ...freshnessShape,
});
export type IssueResult = z.infer<typeof issueResultSchema>;

export const statusResultSchema = z.object({
  state: z.enum(["not_configured", "ready", "error"]),
  configured: z.boolean(),
  /** What is missing when not configured: "site", "email", "apiToken". */
  missing: z.array(z.enum(["site", "email", "apiToken"])),
  siteUrl: z.string().nullable(),
  email: z.string().nullable(),
  /** True when the developer API base URL override is set. */
  usingOverride: z.boolean(),
  account: z
    .object({ accountId: z.string(), displayName: z.string() })
    .nullable(),
  /** The last failure that concerns the connection as a whole. */
  error: failureSchema.nullable(),
  checkedAt: z.number().nullable(),
  integrations: z.object({ taskBoard: z.boolean() }),
});
export type StatusResult = z.infer<typeof statusResultSchema>;

/** Cross-plugin contract (PLAN.md): exact shape, do not extend casually. */
export const issueSummarySchema = z
  .object({
    key: z.string(),
    summary: z.string(),
    status: z.string(),
    statusCategory: statusCategorySchema,
    url: z.string(),
  })
  .nullable();
export type IssueSummary = z.infer<typeof issueSummarySchema>;

/** Issue keys: project key (letter first, then letters, digits, `_`), dash, number. */
export const ISSUE_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,49}-[1-9][0-9]{0,9}$/;

export const issueKeySchema = z
  .string()
  .trim()
  .regex(ISSUE_KEY_PATTERN, "Expected an issue key such as ENG-123")
  .transform((key) => key.toUpperCase());

export const jqlSchema = z.string().trim().min(1).max(4000);
