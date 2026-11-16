# Jira Viewer

Read Jira Cloud issues beside the chat and hand one to a thread. Read-only.
Package `bb-plugin-jira-viewer`, plugin id `jira-viewer`, CLI `bb jira-viewer`,
tools `jira_viewer_search` and `jira_viewer_get_issue`.

The UI is a page with saved views in the sidebar, a grouped issue list and
the issue as a document, plus an Issue tab on threads an issue was sent to.

## Layout

| Path | What |
|---|---|
| `server.ts` | Wires settings, RPC, CLI, tools, mentions, events |
| `app.tsx`, `ui/` | Page, views sidebar, issue document, thread Issue tab; pure UI logic in `ui/logic.ts` |
| `kit/` | Generated copy of the shared kit (`node ../../kit/scripts/sync.mjs jira-viewer`); do not edit |
| `scripts/live.mjs` | Headless live checks: sheet, tab, handoff frames, flash, skeleton, views |
| `src/contract.ts` | The RPC contract (the frontend imports its type) |
| `src/service.ts` | Cache-first reads, background refresh, status, views, thread links |
| `src/jira/client.ts` | REST v3 client: auth, timeouts, Retry-After, error mapping, pagination |
| `src/jira/normalize.ts` | Raw issue JSON to rows and documents |
| `src/adf.ts` | Atlassian Document Format to Markdown |
| `src/store.ts` | SQLite cache, views, thread links |
| `src/cli.ts`, `src/tools.ts`, `src/mentions.ts` | Agent and user surfaces |
| `mock/` | Local Jira mock and fixtures |
| `skills/jira-viewer/` | Agent-facing usage |
| `DECISIONS.md` | Choices and deviations from PLAN.md |

## Develop against the mock

```sh
export npm_config_cache=$TMPDIR/npm-cache
npm install --include=dev
npm run typecheck && npm test && bb plugin build

node mock/server.ts --port 4010          # prints the mock email and token
bb plugin install . --yes
bb plugin config jira-viewer set site acme.atlassian.net
bb plugin config jira-viewer set email dev@example.com
bb plugin config jira-viewer set apiBaseUrl http://127.0.0.1:4010
bb plugin config jira-viewer set apiToken mock-token-not-a-secret
bb jira-viewer check
```

The mock takes `POST /__mock/mode {"mode": "unauthorized" | "forbidden" |
"captcha" | "rate_limited" | "server_error" | "html" | "slow" | "ok",
"retryAfter": s}` to simulate failures. Stop it to simulate the network
being down. `POST /__mock/touch {"key", "summary"}` changes an issue.
`GET /__mock/stats` lists the requests it has served.

Before handing over, unset everything: `apiBaseUrl`, `apiToken`, `email`
and `site`.
