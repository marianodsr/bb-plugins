// `bb jira-viewer`: read-only Jira access for people and agents.
import { PluginCliError, cliCommand, defineCli } from "@get-bb/plugin-sdk";
import { JiraError } from "./jira/client.js";
import {
  TOOL_DOCUMENT_LIMITS,
  formatDocument,
  formatFailure,
  formatRows,
  formatStatus,
  formatViews,
  relativeTime,
  shellQuote,
  textQueryJql,
} from "./format.js";
import { ISSUE_KEY_PATTERN } from "./schemas.js";
import type { JiraViewerService } from "./service.js";

export const CLI_NAME = "jira-viewer";
export const CLI_SEARCH_LIMIT_MAX = 100;

const json = { type: "boolean", description: "Print JSON instead of text" } as const;

function out(stdout: string) {
  return { exitCode: 0, stdout: stdout.endsWith("\n") ? stdout : `${stdout}\n` };
}

function asJson(value: unknown) {
  return out(JSON.stringify(value, null, 2));
}

/** Turn a Jira failure into the CLI's error envelope. */
export function cliFailure(error: unknown): never {
  if (error instanceof JiraError) {
    const failure = error.failure;
    const hints: Record<string, string> = {
      not_configured: "Run `bb jira-viewer status` for the setup steps.",
      unauthorized: "Check the email and API token in Settings → Installed plugins → Jira Viewer, then run `bb jira-viewer check`.",
      rate_limited: "Wait, then try again.",
      bad_request: "Check the JQL syntax.",
      network: "Check the site address and your network, then run `bb jira-viewer check`.",
      timeout: "Try again; Jira may be slow.",
    };
    throw new PluginCliError(formatFailure(failure), {
      code: failure.kind,
      ...(hints[failure.kind] ? { hint: hints[failure.kind] } : {}),
    });
  }
  throw error;
}

function parseKey(raw: string): string {
  const key = raw.trim();
  if (!ISSUE_KEY_PATTERN.test(key)) {
    throw new PluginCliError(`"${raw}" is not an issue key`, {
      code: "invalid_key",
      hint: "Issue keys look like ENG-123.",
    });
  }
  return key.toUpperCase();
}

export function registerCli(
  register: (registration: ReturnType<typeof defineCli>) => void,
  service: JiraViewerService,
  now: () => number = Date.now,
): void {
  register(
    defineCli({
      name: CLI_NAME,
      summary: "Read Jira Cloud issues: search with JQL, read an issue, list saved views",
      description:
        "Read-only. Configure the site, email and API token in Settings → Installed plugins → Jira Viewer.",
      commands: {
        status: cliCommand({
          summary: "Show whether Jira Viewer is set up and connected",
          options: { json },
          async run({ options }) {
            const status = await service.status();
            return options.json ? asJson(status) : out(formatStatus(status));
          },
        }),
        check: cliCommand({
          summary: "Verify the site, email and API token against Jira now",
          options: { json },
          async run({ options }, ctx) {
            const status = await service.checkConnection(ctx.signal);
            if (options.json) return asJson(status);
            if (status.state === "ready" && status.account) {
              return out(`Connected to ${status.siteUrl} as ${status.account.displayName}.`);
            }
            if (!status.configured) return out(formatStatus(status));
            throw new PluginCliError(
              status.error ? formatFailure(status.error) : "Could not verify the connection.",
              { code: status.error?.kind ?? "unknown" },
            );
          },
        }),
        search: cliCommand({
          summary: "Search issues with JQL, plain words, or a saved view",
          description:
            "Pass JQL as the argument, or --query for a text search, or --view for a saved view. Results are paged: pass the printed --page-token to continue.",
          positionals: [
            { name: "jql", description: "JQL, such as 'project = ENG AND statusCategory != Done'", variadic: true },
          ],
          options: {
            query: { type: "string", description: "Plain words to search for (text ~)", aliases: ["text", "q"] },
            view: { type: "string", description: "Saved view id or name (see `views list`)" },
            limit: {
              type: "integer",
              min: 1,
              max: CLI_SEARCH_LIMIT_MAX,
              default: 20,
              description: `Issues per page, 1-${CLI_SEARCH_LIMIT_MAX}`,
            },
            "page-token": { type: "string", description: "Continue from a previous page", aliases: ["next"] },
            json,
          },
          async run({ options, positionals }, ctx) {
            const jqlText = positionals.jql.join(" ").trim();
            const given = [jqlText !== "", options.query !== undefined, options.view !== undefined].filter(Boolean).length;
            if (given !== 1) {
              throw new PluginCliError("Pass exactly one of: JQL, --query or --view", {
                code: "invalid_arguments",
                hint: "Example: bb jira-viewer search 'assignee = currentUser() ORDER BY updated DESC'",
              });
            }
            let jql = jqlText;
            if (options.query !== undefined) jql = textQueryJql(options.query);
            if (options.view !== undefined) {
              const view = service.findView(options.view);
              if (!view) {
                throw new PluginCliError(`No saved view "${options.view}"`, {
                  code: "view_not_found",
                  hint: "Run `bb jira-viewer views list`.",
                });
              }
              jql = view.jql;
            }
            try {
              const result = await service.searchFresh(
                { jql, limit: options.limit, pageToken: options["page-token"] ?? null },
                ctx.signal,
              );
              if (options.json) return asJson(result);
              const sourceArgs =
                options.view !== undefined
                  ? `--view ${shellQuote(options.view)}`
                  : options.query !== undefined
                    ? `--query ${shellQuote(options.query)}`
                    : shellQuote(jqlText);
              const more = result.nextPageToken
                ? `\n\nMore results:\n  bb jira-viewer search ${sourceArgs} --limit ${options.limit} --page-token ${shellQuote(result.nextPageToken)}`
                : "";
              return out(`${formatRows(result.issues, now())}${more}`);
            } catch (error) {
              cliFailure(error);
            }
          },
        }),
        issue: cliCommand({
          summary: "Show one issue with its description, subtasks, links and latest comments",
          positionals: [{ name: "key", description: "Issue key, such as ENG-123", required: true }],
          options: {
            "no-comments": { type: "boolean", description: "Leave out comments" },
            json,
          },
          async run({ options, positionals }, ctx) {
            const key = parseKey(positionals.key);
            try {
              const { doc, fromCache, fetchedAt, failure } = await service.issueForReading(key, ctx.signal);
              if (options.json) return asJson({ issue: doc, fromCache, fetchedAt });
              const note =
                fromCache && failure
                  ? `Showing the cached copy from ${relativeTime(new Date(fetchedAt).toISOString(), now())}: ${formatFailure(failure)}\n\n`
                  : "";
              return out(
                note +
                  formatDocument(doc, {
                    ...TOOL_DOCUMENT_LIMITS,
                    maxDescriptionChars: 20_000,
                    maxComments: 20,
                    maxCommentChars: 4_000,
                    includeComments: !options["no-comments"],
                  }),
              );
            } catch (error) {
              cliFailure(error);
            }
          },
        }),
        "views list": cliCommand({
          summary: "List saved views",
          options: { json },
          async run({ options }) {
            const views = service.listViews();
            return options.json ? asJson({ views }) : out(formatViews(views));
          },
        }),
        "views add": cliCommand({
          summary: "Save a JQL query as a view",
          positionals: [{ name: "name", description: "View name", required: true }],
          options: { jql: { type: "string", required: true, description: "The view's JQL (max 4000 characters)" }, json },
          async run({ options, positionals }) {
            const name = positionals.name.trim();
            const jql = options.jql.trim();
            if (name === "" || name.length > 80) {
              throw new PluginCliError("View names are 1-80 characters", { code: "invalid_name" });
            }
            if (jql === "" || jql.length > 4000) {
              throw new PluginCliError("JQL must be 1-4000 characters", { code: "invalid_jql" });
            }
            const view = service.createView(name, jql);
            return options.json ? asJson(view) : out(`Saved view ${view.name} (${view.id}).`);
          },
        }),
        "views remove": cliCommand({
          summary: "Delete a saved view",
          positionals: [{ name: "view", description: "View id or name", required: true }],
          async run({ positionals }) {
            const view = service.findView(positionals.view);
            if (!view || !service.deleteView(view.id)) {
              throw new PluginCliError(`No saved view "${positionals.view}"`, { code: "view_not_found" });
            }
            return out(`Deleted view ${view.name}.`);
          },
        }),
        "cache stats": cliCommand({
          summary: "Show what the local issue cache holds",
          options: { json },
          async run({ options }) {
            const stats = service.cacheStats();
            if (options.json) return asJson(stats);
            return out(
              `Issues: ${stats.issues} of ${stats.limits.maxIssues} (${stats.documents} with full documents)\nSearches: ${stats.searches} of ${stats.limits.maxSearches}`,
            );
          },
        }),
        "cache clear": cliCommand({
          summary: "Drop cached issues and searches (views and thread links stay)",
          async run() {
            service.clearCache();
            return out("Cleared the issue cache.");
          },
        }),
      },
    }),
  );
}
