---
name: jira-viewer
description: Read Jira Cloud issues through the Jira Viewer plugin (read-only) — search with JQL, words or a saved view, read an issue as Markdown, check setup. Use the jira_viewer_* tools or `bb jira-viewer`.
---

# Jira Viewer

Read-only access to the user's Jira Cloud site. It cannot create, edit,
comment on, assign or transition issues.

## Tools

- `jira_viewer_search` — exactly one of `jql`, `query` (plain words, a
  `text ~` search) or `view` (saved view id or name). `limit` 1-50, default
  20. When the result ends with `nextPageToken: …`, call again with the same
  query and `pageToken` to get the next page; do not raise `limit` instead.
- `jira_viewer_get_issue` — `key` such as `ENG-123`, optional
  `includeComments` (default true). Returns Markdown: metadata, description,
  subtasks, links, attachment names, the latest 10 comments. Descriptions over
  8,000 characters and comments over 1,500 are truncated; say so if it
  matters, and point to the issue URL.

If Jira cannot be reached, `jira_viewer_get_issue` returns the cached copy
with a note saying how old it is. Mention that when you rely on it.

## CLI

```
bb jira-viewer status [--json]                  # set up? connected? as whom
bb jira-viewer check [--json]                   # verify site, email, token now
bb jira-viewer search '<JQL>' [--limit N] [--page-token T] [--json]
bb jira-viewer search --query 'words' | --view 'My open issues'
bb jira-viewer issue ENG-123 [--no-comments] [--json]
bb jira-viewer views list | views add <name> --jql '<JQL>' | views remove <id|name>
bb jira-viewer cache stats | cache clear
```

`search` pages up to 100 per call; follow the printed `--page-token`.
Errors carry a code with `--json`: `not_configured`, `unauthorized`,
`forbidden`, `not_found`, `rate_limited`, `bad_request` (usually invalid
JQL), `timeout`, `network`, `server`, `invalid_response`.

## Setup

When a tool says Jira Viewer is not set up, tell the user. Do not look for
credentials or try other ways to reach Jira. The user sets:

```
bb plugin config jira-viewer set site acme.atlassian.net
bb plugin config jira-viewer set email you@example.com
```

and the API token (from id.atlassian.com → Security → API tokens) in
Settings → Installed plugins → Jira Viewer. The token is a secret setting
and never appears in any output. Then `bb jira-viewer check`.

`apiBaseUrl` is a developer override for a mock server; leave it empty.

## JQL that works well

- `assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC`
- `project = ENG AND text ~ "upload" ORDER BY updated DESC`
- `issue in issueHistory() ORDER BY lastViewed DESC` (recently viewed)
- `key in (ENG-1, ENG-2)`

The user can also mention an issue in the composer (`@ENG-123` or `@words`);
its content then arrives as context, so there is no need to fetch it again.

## What the user sees

The Jira page (`/plugins/jira-viewer/issues`, or `/plugins/jira-viewer/issues/ENG-123`
for one issue) lists saved views and issues, and reads an issue as a
document. When the user sends an issue to a thread, the message holds the
issue as Markdown, the thread shows an Issue tab with the live issue, and the
thread's plugin metadata carries `jiraIssueKeys`. Refer the user there rather
than pasting long issue text back to them.
