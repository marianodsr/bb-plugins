# Jira Viewer: agent tool check

This makes one real call to each Jira Viewer agent tool against the local mock,
then returns the plugin to "not configured". The mock token below is a fixture,
not a credential.

## 1. Set up (in a terminal, before starting the checking thread)

Start the mock and leave it running:

```sh
cd /Users/marianodsr/projects/bb-plugins/plugins/jira-viewer
node mock/server.ts --port 4010
```

In another terminal, point the plugin at the mock:

```sh
bb plugin config jira-viewer set site acme.atlassian.net
bb plugin config jira-viewer set email dev@example.com
bb plugin config jira-viewer set apiBaseUrl http://127.0.0.1:4010
bb plugin config jira-viewer set apiToken mock-token-not-a-secret
bb jira-viewer check     # expect: Connected to https://acme.atlassian.net as Dev User.
```

## 2. Tool calls (in the checking thread)

The thread must start after step 1. Tools attach when a session starts.

### `jira_viewer_search` with `{"view": "My open issues", "limit": 5}`

Expect: not an error. The result starts with
`JQL: assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC`,
followed by a table with columns Key, Status, Assignee, Updated, Summary and
five rows. The keys in order are ENG-609, ENG-604, ENG-589, ENG-584 and
ENG-574, all assigned to Dev User. The Updated column is relative to the
current time. The last line is `More results. nextPageToken: <token>`.

Optional follow-up: call it again with the same arguments plus that
`pageToken`. Expect five more rows and no repeats.

### `jira_viewer_get_issue` with `{"key": "ENG-412"}`

Expect: not an error. The Markdown starts:

```
# ENG-412: Session expires mid-upload

https://acme.atlassian.net/browse/ENG-412

- Status: In Progress
- Type: Bug
- Priority: High
- Assignee: Dev User
- Reporter: Ana Ruiz
```

It also contains:
- `### What happens` (description headings nest under `## Description`)
- a ` ```ts ` code block
- the table `| Size | Result |`
- `## Subtasks (1 of 2 done)`, listing ENG-413 and ENG-414
- `## Links`, with `is blocked by ENG-398`
- `## Attachments`, with `upload-error.png (image/png)`
- `## Comments (3)`, ending with Dev User's "Taking this. 👍"

It is under 30,000 characters.

### Failures (optional)

| Call | Expect |
|---|---|
| `jira_viewer_get_issue {"key": "ENG-99999"}` | `isError`, text `Jira not found: Issue does not exist or you do not have permission to see it.` |
| `jira_viewer_search {"jql": "bogus = 1"}` | `isError`, text starting `Jira bad request: Jira could not run that: Error in the JQL Query: Field 'bogus' does not exist` |
| `jira_viewer_search {"jql": "x", "query": "y"}` | rejected by the parameter schema: "Pass exactly one of jql, query or view" |

## 3. Clean up (return to "not configured")

```sh
bb jira-viewer cache clear
bb plugin config jira-viewer unset apiBaseUrl
bb plugin config jira-viewer unset apiToken
bb plugin config jira-viewer unset email
bb plugin config jira-viewer unset site
bb plugin reload jira-viewer
bb plugin list | grep -A1 '^jira-viewer'   # expect: needs-configuration
bb jira-viewer cache stats                  # expect: Issues: 0 ... Searches: 0
```

Stop the mock with Ctrl+C. The tools make no writes, so there is nothing else
to undo.
