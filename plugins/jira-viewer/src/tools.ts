// Agent tools. Names carry the `jira_viewer_` prefix: the store's Jira plugin
// owns `jira_*`, and tool names are unique across every installed plugin.
import { z } from "zod";
import { JiraError, isAbortError } from "./jira/client.js";
import {
  TOOL_DOCUMENT_LIMITS,
  formatDocument,
  formatFailure,
  formatRows,
  relativeTime,
  textQueryJql,
} from "./format.js";
import { issueKeySchema } from "./schemas.js";
import type { JiraViewerService } from "./service.js";

export const TOOL_SEARCH = "jira_viewer_search";
export const TOOL_GET_ISSUE = "jira_viewer_get_issue";
export const TOOL_SEARCH_LIMIT_MAX = 50;

type ToolResult = string | { content: { type: "text"; text: string }[]; isError?: boolean };

function toolError(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function failureText(error: unknown): ToolResult {
  if (error instanceof JiraError) {
    const failure = error.failure;
    if (failure.kind === "not_configured") {
      return toolError(
        `${failure.message} Tell the user; do not try other ways to reach Jira.`,
      );
    }
    return toolError(`Jira ${failure.kind.replace("_", " ")}: ${formatFailure(failure)}`);
  }
  if (isAbortError(error)) return toolError("Cancelled.");
  throw error;
}

export const searchParameters = z
  .object({
    jql: z.string().trim().min(1).max(4000).optional().describe("JQL query, such as `project = ENG AND statusCategory != Done ORDER BY updated DESC`"),
    query: z.string().trim().min(1).max(200).optional().describe("Plain words for a full-text search; used when jql is not given"),
    view: z.string().trim().min(1).max(80).optional().describe("A saved view id or name, such as `My open issues`"),
    limit: z.number().int().min(1).max(TOOL_SEARCH_LIMIT_MAX).default(20).describe(`Issues per page, 1-${TOOL_SEARCH_LIMIT_MAX}`),
    pageToken: z.string().min(1).max(2000).optional().describe("nextPageToken from a previous call with the same query"),
  })
  .strict()
  .refine(
    (input) => [input.jql, input.query, input.view].filter((value) => value !== undefined).length === 1,
    { message: "Pass exactly one of jql, query or view" },
  );

export const getIssueParameters = z
  .object({
    key: issueKeySchema.describe("Issue key, such as ENG-123"),
    includeComments: z.boolean().default(true).describe("Include the latest comments"),
  })
  .strict();

export function buildTools(service: JiraViewerService, now: () => number = Date.now) {
  const search = {
    name: TOOL_SEARCH,
    description:
      "Search Jira Cloud issues (read-only) with JQL, plain words, or a saved view. Returns key, status, assignee, last update and summary per issue, one page at a time.",
    instructions:
      "Jira Viewer tools are read-only. Use jira_viewer_search to find issues and jira_viewer_get_issue to read one; page with nextPageToken instead of raising limit.",
    presentation: { label: { pending: "Searching Jira", completed: "Searched Jira" } },
    parameters: searchParameters,
    async execute(
      args: z.infer<typeof searchParameters>,
      ctx: { signal: AbortSignal },
    ): Promise<ToolResult> {
      let jql = args.jql ?? (args.query !== undefined ? textQueryJql(args.query) : "");
      if (args.view !== undefined) {
        const view = service.findView(args.view);
        if (!view) {
          const names = service.listViews().map((candidate) => candidate.name).join(", ");
          return toolError(`No saved view "${args.view}". Saved views: ${names || "none"}.`);
        }
        jql = view.jql;
      }
      try {
        const result = await service.searchFresh(
          { jql, limit: args.limit, pageToken: args.pageToken ?? null },
          ctx.signal,
        );
        const lines = [`JQL: ${jql}`, "", formatRows(result.issues, now())];
        lines.push(
          "",
          result.nextPageToken
            ? `More results. nextPageToken: ${result.nextPageToken}`
            : `End of results (${result.issues.length} on this page).`,
        );
        return lines.join("\n");
      } catch (error) {
        return failureText(error);
      }
    },
  };

  const getIssue = {
    name: TOOL_GET_ISSUE,
    description:
      "Read one Jira Cloud issue (read-only) as Markdown: metadata, description, subtasks, links, attachments by name, and the latest comments. Long descriptions and comments are truncated.",
    presentation: { label: { pending: "Reading Jira issue", completed: "Read Jira issue" } },
    parameters: getIssueParameters,
    async execute(
      args: z.infer<typeof getIssueParameters>,
      ctx: { signal: AbortSignal },
    ): Promise<ToolResult> {
      try {
        const { doc, fromCache, fetchedAt, failure } = await service.issueForReading(args.key, ctx.signal);
        const body = formatDocument(doc, { ...TOOL_DOCUMENT_LIMITS, includeComments: args.includeComments });
        if (fromCache && failure) {
          return `Note: Jira could not be reached (${formatFailure(failure)}). This is the cached copy from ${relativeTime(new Date(fetchedAt).toISOString(), now())}.\n\n${body}`;
        }
        return body;
      } catch (error) {
        return failureText(error);
      }
    },
  };

  return [search, getIssue] as const;
}
