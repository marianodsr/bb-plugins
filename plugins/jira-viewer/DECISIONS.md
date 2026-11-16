# Jira Viewer decisions

Choices PLAN.md and DESIGN.md leave open, and deviations from them. Newest
last.

## Phase A

1. **Search endpoint.** `POST /rest/api/3/search/jql` with `nextPageToken`
   (Atlassian removed `/rest/api/3/search`; the mock answers it with 410). A
   page asks for at most 100 issues (Jira's cap when fields are requested).
   Paging stops on a missing token, `isLast: true`, an empty page, or a token
   Jira already handed out (a reported Jira bug loops otherwise).
2. **Status categories** are `"todo" | "in_progress" | "done"`. Jira's `new`
   and its rare `undefined` (No Category) both map to `todo`. This is the
   `statusCategory` value in the `issueSummary` contract.
3. **Storage beyond PLAN.md.** `issues_cache` also holds `doc_json`,
   `doc_fetched_at` and `accessed_at` (row and document in one place, LRU
   eviction). Added `search_cache` (ordered keys per JQL, so lists paint from
   cache) and `meta` (one-time view seeding). `views` and `thread_issues` are
   as planned.
4. **Cache bounds.** 2,000 issues and 200 searches, least recently used
   evicted, pruned at most every 30 s. Changing the site, base URL or email
   clears cached issues; changing only the token does not.
5. **Freshness.** Lists are stale after 60 s, documents after 120 s, the
   cross-plugin summary after 10 minutes. A read with nothing cached waits up
   to 2.5 s for the first fetch, then returns `refreshing: true`. While a
   client watches a list or issue (`experimental_whileWatched`), the server
   refreshes it on the same intervals.
6. **Load more** raises `limit` on `issues.list` (max 200) instead of exposing
   page tokens to the UI: one cache entry per JQL, no token state in clients.
   Tools and the CLI pass Jira's tokens through, because they read fresh.
7. **Failure kinds** add `bad_request` (usually invalid JQL), `timeout`,
   `server` and `invalid_response` (HTML login pages, redirects) to the
   brief's list. A 403 with `X-Seraph-LoginReason: AUTHENTICATION_DENIED`
   (CAPTCHA lockout) is `unauthorized` with its own message.
8. **Rate limits.** `Retry-After` (seconds or HTTP date, default 30 s when
   missing, capped at 1 h) sets a gate shared by every client instance; while
   it holds, calls fail fast with `rate_limited` and no request. A wait of at
   most 2 s is retried once in place. A 503 with `Retry-After` counts as rate
   limited.
9. **Timeouts.** 15 s per request, combined with the caller's signal. A
   caller abort is an abort, not a failure. Background refreshes follow the
   plugin's lifetime signal, not the request that started them.
10. **Developer base URL override** is a visible setting, `apiBaseUrl`,
    labelled "Developer". It takes https, or plain http only for
    localhost/127.0.0.1/::1, so a token never goes in clear text to another
    machine. Browse links still use the site; with only the override set,
    links use the override.
11. **needs-configuration.** The factory calls `bb.status.needsConfiguration`
    when anything is missing. Verified live: RPC and the CLI keep answering
    in that state, so the setup screen can read `status`, and saving settings
    reloads the plugin into `running`.
12. **Comments** come from the issue's `comment` field; the newest 50 are kept
    and `commentsTotal` reports Jira's count.
13. **ADF rendering.** Panels become a blockquote with a bold label
    (`> **Warning**`). Status lozenges become inline code. Media becomes
    `*Attachment: name*` (external images become a link). Mentions become
    `@Name`. Hard breaks become backslash-newline. Table cells fold block
    content onto one line (`•` for list items). The first row is always the
    header. Colspans pad with empty cells. Unsafe link schemes drop the link
    and keep the text. Past 400 levels a subtree folds to its plain text
    without recursion. The UI receives the description Markdown unchanged;
    the text renderings nest its headings under their section.
14. **Output bounds.** Tools: 50 rows per search page; issue description
    8,000 characters and 10 comments of 1,500 each. Mention context: 6,000
    and 5 × 1,000. CLI `issue`: 20,000 and 20 × 4,000. Stored bodies are
    capped at 100,000 characters.
15. **Mentions** use the default `@` trigger and stay silent below two
    characters. They answer from the cache first, then try Jira within
    1.2 s (bb allows 2 s): a key-shaped query looks the issue up, three or
    more characters run `text ~`. `resolve` never throws, because throwing
    would block the user's send; on failure the context says what could not
    be loaded.
16. **Default views** are seeded once: My open issues, Reported by me, Recent
    (`issue in issueHistory() ORDER BY lastViewed DESC`). Deleting one does
    not bring it back.
17. **Add to Task Board** is the server RPC `addToTaskBoard`, because the
    frontend cannot call another plugin's RPC. It calls Task Board's
    `createTask` with title = summary, body = bounded issue Markdown,
    `externalRef = { kind: "jira", key, url }`, and the optional `projectId`.
    It returns `{ id, route }`. Detection: `bb.sdk.plugins.list()` reports
    `task-board` running (cached 30 s), exposed as
    `status.integrations.taskBoard`.
18. **Phase A is headless.** `bb.app` and the scaffold's todo example are
    removed. The scaffold's vendored `components/`, `lib/` and `hooks/` stay
    for phase B, pending what the kit provides.
19. **Tags.** `status`, `views`, `search:<queryId>`, `issue:<KEY>`,
    `thread:<threadId>`. Lists tag every issue they show, so a change to one
    issue refreshes every read that displays it.
20. **Branding icon.** `Ticket` falls back to Zap (proven with a probe page
    in phase B), as do `Kanban` and `Tag`. The plugin uses `LayoutList` for
    branding and the page, and `FileText` for the thread's Issue tab.

## Phase B

21. **Routes.** The panel lives at `/plugins/jira-viewer/issues`. Its
    subPath is `views/<id>`, `search/<jql>`, either one followed by `/<KEY>`,
    or a bare `<KEY>`: the cross-plugin route, which lists the last source the
    user looked at (kept in localStorage per plugin id).
22. **Layout.** At a container width of 900 px or more, the issue opens beside
    the list. `j`/`k` move the reading pane too, using history `replace`. Below
    900 px the issue replaces the list, with a "Back to list" control.
23. **Escape.** While an issue is open, Escape closes it. The page claims the
    key in the capture phase, because bb maps Escape to "Back to app" while a
    plugin sidebar is showing. It steps aside while the user is typing, when
    a dialog or popover is open, or when focus is outside the page. With
    nothing open, Escape is bb's again.
24. **Failure backoff.** A read whose last refresh failed does not retry until
    the refresh interval (or `Retry-After`, when longer) has passed. Without
    this, a failing query re-fetched on every read: each failure invalidated
    the read, which started another fetch. Only Refresh (`r`) forces a request.
25. **The thread's Issue tab** is a fixed thread tab. It is visible when
    `thread.issues` has keys, and links come from a handoff's `onSent`. In the
    tab, single-letter hotkeys and their hints are off: inside a thread view
    they would fire whenever nothing is focused. Buttons and Tab still reach
    every action.
26. **Handoff.** The items are the open issue; the noun is "issue". The prompt
    is bounded issue Markdown plus a line pointing to `jira_viewer_get_issue`.
    `pluginMetadata` is `{ jiraIssueKeys }`. New threads are titled
    "KEY summary". The key is `t`.
27. **Add to Task Board** (`a`) shows "On Task Board" rather than "Added",
    because `createTask` returns the existing task for a key it already has.
    The thread tab passes its project. The page has no project, so Task Board
    applies its own default.
28. **Saved views.** Create, rename, edit and delete happen in place, and
    every write is optimistic. Delete takes effect at once and offers Undo in
    a toast, which recreates the view at its old position; DESIGN keeps
    dialogs for the composer and destructive confirmation. Reorder uses
    Alt+Arrow on a focused view. There is no drag. "Save as view" turns an
    ad-hoc search into a view.
29. **Search box.** An issue key opens that issue. Text with a JQL operator,
    a function call or an uppercase keyword runs as JQL. Anything else becomes
    `text ~ "…"`. The box labels which one it will run.
30. **Rows.** Columns are key (tabular figures), summary, and the assignee's
    first name or "–". An age column appears from 448 px of container width
    and a status tint from 672 px. Status-category tints: to do gray, in
    progress blue, done green.
31. **Changed rows flash once**, when an issue's `updated` changes between two
    loads of the same list. First paint never flashes.
32. **Comments.** The latest 5 show; earlier ones fold behind "Show N earlier
    comments", placed above them. Comments older than the latest 50 are
    noted as only in Jira.
33. **Inline cards** that point at a Jira issue read as the issue key.
34. **Skeletons come from the kit.** Kit `36f976388355` fixed `SkeletonRows`,
    which had drawn its title bars at zero width. The list and the sidebar use
    it again, so all three plugins share one skeleton.
35. **Mock fixtures** carry varied content: a long multi-section description
    with SQL, a table and a panel (ENG-420); 12 comments (ENG-398); 5 subtasks
    (ENG-440); unassigned issues; a very long summary; labels; links; and 110
    realistic backlog items for paging.
