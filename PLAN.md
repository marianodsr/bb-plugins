# BB plugins plan

Three plugins written from scratch, plus a shared design kit. Design language:
[docs/DESIGN.md](docs/DESIGN.md).

## Layout

```
kit/                     # shared design layer, source of truth (kit thread owns it)
plugins/
  kit-gallery/           # dev-only plugin that renders every kit piece (kit thread)
  review-editor/         # editor + git diffs + line comments + handoff
  task-board/            # local kanban of tasks linked to threads
  jira-viewer/           # read-only Jira Cloud issues
docs/
  DESIGN.md              # design language, binding for all UI
  CONVENTIONS.md         # build and verification facts found by the kit thread
  briefs/                # one brief per thread
  screenshots/<plugin>/  # visual evidence from live checks
upstream/                # snapshots of store plugins; SDK usage reference only
```

| Plugin | Package | Id | Display name | CLI | Tool prefix |
|---|---|---|---|---|---|
| Review Editor | `bb-plugin-review-editor` | `review-editor` | Review Editor | `bb review` | `review_` |
| Task Board | `bb-plugin-task-board` | `task-board` | Task Board | `bb tasks` | `tasks_` |
| Jira Viewer | `bb-plugin-jira-viewer` | `jira-viewer` | Jira Viewer | `bb jira-viewer` | `jira_viewer_` |
| Kit gallery | `bb-plugin-kit-gallery` | `kit-gallery` | Kit Gallery | none | none |

The store's `jira`, `taskboard`, `diff-review` and `files-editor` plugins may be
installed alongside. Tool names are unique across all plugins, so never use the
bare `jira_` or `taskboard_` prefixes. If a CLI name collides, pick the next
clearest name and record it.

## Decisions

- Review Editor is a standalone editor built on CodeMirror 6 (`@codemirror/merge` for diffs).
- Task Board is per project with an all-projects view. Tasks are local to bb.
- Jira Viewer is read-only in v1, Jira Cloud, API-token auth.
- Animation library: `motion`. Colours: host tokens only.
- Personal use first. No marketplace submission.

## Phases

| Phase | Threads | Output |
|---|---|---|
| A | kit; and in parallel the three plugin threads on backend only | `kit/`, gallery, `docs/CONVENTIONS.md`; each plugin's data model, RPC, CLI, tools, skill, tests |
| B | three plugin threads, after the kit is ready | full UI per DESIGN.md, verified live with screenshots |
| C | coordinator | cross-plugin links checked, consistency pass, final report |

Plugin threads stop at the end of phase A and report. The coordinator tells
each one when to start phase B.

## Shared kit (phase A, kit thread)

Source lives in `kit/`. A sync script copies it into each plugin as
`plugins/<id>/kit/` (generated, do not edit there), unless the kit thread
proves a simpler sharing method works for path installs and builds.

- `motion.ts`: the spring and duration tokens from DESIGN.md, reduced-motion
  handling, shared variants (fade-scale, collapse, list item).
- `kit.css`: easing and duration custom properties, keyframes (live pulse,
  skeleton, progress line).
- Components: `Kbd`, `ShortcutHint`, `ShortcutSheet` (`?`), `Segmented`
  (sliding thumb), `StatusDot` (idle, running, waiting, failed), `ThreadChip`
  (title + live status, opens the thread), `Collapse`, `Skeleton`,
  `ProgressLine`, `EmptyState`, `Tint` (categorical hue chip), `InlineComposer`.
- Hooks: `useHotkeys` (scoped, ignores typing in inputs), `useContainerWidth`.
- Handoff: `HandoffSheet` + `useHandoff`. Targets: this thread (insert into
  its composer, or send now), another thread (searchable picker,
  `threads.send`), new thread (`NewThreadComposer` in a dialog). The caller
  supplies the items, a prompt builder and `pluginMetadata`; the kit owns the
  target picker, the prompt preview, the signature animation and the
  "Sent to <thread>" result.

## Review Editor

Data (plugin SQLite): `comments` (id, environment_id, thread_id, path,
start_line, end_line, snippet, file_sha, body, severity, state
open|sent|resolved|outdated, sent_thread_id, created_at, updated_at) and
`replies` (comment_id, author user|agent, body, created_at).

| Step | Scope |
|---|---|
| A1 | RPC contract with tags and invalidation: file read and CAS save through `bb.sdk.files`, `HEAD` side, changed files via `bb--git`, comment CRUD, re-anchoring by snippet, prompt compile. |
| A2 | `bb review` CLI and tools `review_list_comments`, `review_reply`, `review_resolve`; `agents.configure` adds a short instruction when the thread has sent comments. Skill doc. Tests. |
| A3 | Spike only: prove CodeMirror 6 bundles and renders in a `fileOpener`. |
| B1 | Editor: `fileOpener`, save with conflict handling, host-matched syntax theme, find, go to line, external-change reload. |
| B2 | Diffs: gutter change bars against `HEAD`, peek old lines in place, Edit/Diff switch, unified and split. |
| B3 | Comments: selection toolbar, margin rail and narrow fold, replies, severity, outdated handling, keyboard walk (`]` and `[`). |
| B4 | Review tab on threads: changed files, comments by file, states. Palette commands. |
| B5 | Handoff through the kit, comment states update, agent replies appear live. |

## Task Board

Data: `tasks` (id, project_id, title, body, lane_id, position, priority,
labels, external_ref, created_at, updated_at, archived_at), `lanes` (id,
project_id, name, position, kind todo|doing|review|done), `task_threads`
(task_id, thread_id), `task_events` (task_id, actor user|agent, kind, payload,
created_at).

| Step | Scope |
|---|---|
| A1 | Storage, RPC contract with tags, fractional ordering for positions, default lanes per project, realtime invalidation, thread status join. |
| A2 | `bb tasks` CLI and tools `tasks_list`, `tasks_get`, `tasks_create`, `tasks_update`, `tasks_move`, `tasks_comment`; `agents.configure` injects the linked task for threads with `pluginMetadata.taskId`. Skill doc. Tests. |
| B1 | Board page: lanes, cards, inline create, drag and keyboard move, optimistic writes, nav badge (tasks in Review). |
| B2 | Task detail in the page side panel: document view, edit in place, activity, linked threads with `ThreadChat`. |
| B3 | Start work through the kit handoff (new or existing thread); live line on running cards; cards move on agent writes. |
| B4 | List view with morph, search, filters, all-projects view, lane management. |
| B5 | Thread context card row for the linked task; palette commands; external reference chip. |

## Jira Viewer

Data: `issues_cache` (key, json, fetched_at), `views` (id, name, jql,
position), `thread_issues` (thread_id, issue_key).

| Step | Scope |
|---|---|
| A1 | Settings (site, email, secret token), status, Jira REST client with pagination, rate-limit and error mapping, ADF to Markdown, cache with stale-while-revalidate. Built and tested against recorded-shape fixtures and a local mock server; no real credentials needed. |
| A2 | RPC contract with tags; `bb jira-viewer` CLI; tools `jira_viewer_search`, `jira_viewer_get_issue`; composer mention provider for issue keys if the SDK contract allows. Skill doc. Tests. |
| B1 | Page: sidebar of saved views, issue list grouped by status category, search and JQL, cache-first paint with progress line. |
| B2 | Issue document: description, metadata line, subtasks, comments, links, Open in Jira. |
| B3 | Handoff through the kit; Issue tab on linked threads; setup state when credentials are missing. |
| B4 | Custom views, keyboard navigation, changed-row flash. |

## Cross-plugin contracts

Each side feature-detects the other plugin and hides the link when it is absent.

- Jira Viewer route: `/plugins/jira-viewer/issues/<KEY>` opens that issue.
  RPC `issueSummary({ key })` returns `{ key, summary, status, statusCategory, url }` or `null`.
- Task Board route: `/plugins/task-board/board/task/<id>` opens that task.
  RPC `createTask({ title, body?, projectId?, externalRef? })` returns `{ id }`,
  where `externalRef` is `{ kind: "jira", key, url }`.
- Task Board shows a task's Jira reference as a chip that opens Jira Viewer.
  Jira Viewer offers "Add to Task Board" on an issue.

## Working agreements for every thread

- Read this file, `docs/DESIGN.md`, and `docs/CONVENTIONS.md` when it exists.
  Load the `bb-plugin-authoring` skill and read the references your work
  touches; the installed SDK types are the contract. For UI, load
  `frontend-design` and follow DESIGN.md.
- Write only inside your own directory (`plugins/<id>/`, or `kit/` and
  `plugins/kit-gallery/` for the kit thread) and `docs/screenshots/<id>/`.
  Never edit `upstream/`, another plugin, or the generated `kit/` copy.
- `upstream/` shows how others used the SDK. Do not copy code from it.
- Leave the user's bb alone outside your plugin: no app-wide settings, no
  other plugin's settings or secrets, no enabling, disabling or removing
  plugins you did not install. Installing your own plugin from its path is expected.
- This folder is not a git repository. Do not create one.
- Do not spawn threads. In-session subagents are fine.
- Verify before reporting: typecheck, tests, `bb plugin build`, and for UI a
  live check in bb with screenshots in light and dark, wide and 420 px,
  reviewed against DESIGN.md.
- When a choice is not covered, take the conservative option, record it in
  `plugins/<id>/DECISIONS.md`, and continue.
- Final report: what works and how it was verified, what failed or is
  unverified, deviations from this plan, open questions.
