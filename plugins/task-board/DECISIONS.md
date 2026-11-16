# Task Board decisions

Choices not covered by PLAN.md, taken conservatively.

## Data

- **Fractional position keys** (`src/ordering.ts`): base-62 strings compared as
  plain strings. A move writes one row. Appends bump the first digit with room,
  so keys grow about one character per 61 appends at the end of a lane. Ties (never
  produced, possible from imported data) order by id.
- **Move anchors are re-read at write time.** A client names the neighbour it
  dropped next to (`afterTaskId`, else `beforeTaskId`); the server places the
  task directly after/before that neighbour as it is now. An anchor that left
  the lane is ignored, then `placement` (default bottom). This is what makes a
  user drag and an agent move interleave without renumbering.
- **One task per thread.** `task_threads` has a unique index on `thread_id`.
  Linking a thread that is on another task moves the link, with an event on
  both tasks. Thread metadata holds a single `taskId`, so it stays a mirror.
- **Event actor `system`** in addition to `user` and `agent`, for changes bb
  causes (a seeded link adopted, a deleted thread unlinked). PLAN.md listed
  only user and agent.
- **`updated_by` and `external_key` columns** on `tasks` (not in PLAN.md):
  `updated_by` lets cards tell an agent's move apart without reading events;
  `external_key` indexes `createTask` de-duplication.
- **Priority** is one of none, low, medium, high, urgent. **Labels** are a
  JSON array, at most 10 of 32 characters, de-duplicated.
- **Default lanes** (To do, In progress, Review, Done) are created on a
  project's first read. A board has 1 to 12 lanes; a lane with tasks is
  deleted only by naming a lane to move them to.
- Lane kinds drive meaning (badge counts review, agents move by kind);
  names are free.

## Threads

- **Status is read from bb, never stored.** `threadStatuses` is a keyed read
  (`thread:<id>` per key) over `bb.sdk.threads.list({ threadIds })`, batched
  by 200, with a second call for archived threads only when some are missing.
- **How the board learns about changes:** one `bb.sdk.subscribe` on
  `thread:changed`, filtered by a set lookup to linked threads and to
  `status-changed`, `interactions-changed`, `archived-changed`,
  `title-changed`, `thread-deleted`. Streaming output is ignored.
  Invalidations are coalesced over 50 ms. A reconnect refreshes every linked
  thread. `thread.deleted` removes the link (an event, not a copy of status).
- **State mapping:** archived > pending interaction (`waiting`) > runtime
  display status (`active`, `starting`, `stopping`, `provisioning`,
  `waiting-for-host` are `running`; `error` is `failed`) > `idle`. Deleted or
  unknown threads are `missing`.
- **Seeded links are adopted** when a thread created with this plugin's
  `pluginMetadata.taskId` appears (`thread.created`, startup reconcile, or the
  thread's first `configure`). Accepted only for a well-formed id of an
  existing task in the thread's own project, and only when the thread has no
  link yet; the table wins over metadata.
- **Cross-project links are refused.** A thread links only to tasks of its
  own project.
- **Tools only for linked threads.** Unlinked threads get no `tasks_` tools
  (the skill covers `bb tasks`), which keeps tool lists short everywhere else.
  The skill is selected for every thread.
- Linking alone does not move the card, and the board never moves a card on
  thread status. "Start work" is the exception the coordinator settled: the
  `startWork` write links the thread and moves a to-do card to the first
  doing lane in one commit (one refresh). Agents are told to move their task
  to doing when they start.
- Lanes are created only when the user opens a project's board or a task is
  created there. Reads (`bb tasks lanes`, tool and CLI lane lookups, the
  all-projects board) never create them. The appended cleanup migration removed boards that had
  no tasks, which cleared the empty lanes an early test left on another project.

## Cross-plugin

- `createTask` without `projectId` uses the board read most recently, else the
  first project in bb's order.
- `createTask` with `externalRef` returns the open task that already carries
  the same reference instead of creating a duplicate: in the given project,
  or on any board when no `projectId` is passed. A create that names a
  project also makes it the default for later creates without one.
- `createTask` accepts extra optional fields (`id`, `laneId`, `placement`,
  `priority`, `labels`) for the app's optimistic create. The PLAN.md fields
  and the `{ id }` result are unchanged. Inputs are strict: unknown fields are
  rejected.

## Names

- CLI `bb tasks` is free on bb 0.49.0 (no core command; the store plugin uses
  `bb taskboard`). Tools use `tasks_`; the store plugin's tools are
  `taskboard_*`, so there is no collision.

## Phase B (UI)

- **Task detail is an action tab** in the board page's side panel, titled
  with the task, one at a time: opening another task closes the previous
  tab. A fixed tab kept the panel open with an empty state on every visit,
  and `close()` did not hold. The action launcher stays visible in the
  panel's new-tab menu; hiding it with `useVisible: () => false` made bb
  refuse `openTab` too.
- **Compact layout**: bb accepts the tab but keeps its drawer closed, so the
  task opens as a sheet over the board (Board back control, Escape, focus
  returns to the card). Decided by `getTabs().open` after `openTab`, with one
  retry for a cold page.
- **Cross-plugin route** `/board/task/<id>` redirects (replace) to the
  canonical `/board/p/<project>/task/<id>` once the task's project is known.
- **Thread status on cards**: bb's live sidebar view (the kit's
  `useLiveThread` / `threadRunStatus`) first; threads it does not carry come
  from the `threadStatuses` keyed read, one batched request per board.
- **Agent moves travel**: cards carry a motion `layoutId`; a card that is
  already on the board and appears in a new lane skips the entrance fade and
  sits above the lanes it crosses. Exits use `popLayout`, so nothing leaves a
  gap. The pointer-drag placeholder has no `layoutId` and jumps between lanes.
- **Drag**: a portal clone follows the pointer without a spring; pick-up and
  drop use the `lift` spring; neighbours make room with `shift`. Drop targets
  come from geometry snapshotted at pick-up (stable while cards animate),
  corrected for board scroll; the board auto-scrolls near its edges. Text
  selection is suspended while dragging. Keyboard lifting is refused while a
  search or filter hides cards, since the drop slot would be ambiguous.
- **Linked task beside its thread**: a context-card row and a banner segment
  (bb shows one or the other per pane).
- **Palette commands** run outside React, so `useBbNavigate` and `useRpc` are
  captured by the nav badge hook, which bb keeps mounted.
- **Built here, not in the kit**: the board, drag and drop, the lane menu,
  the project picker, the filter menu and the detail's pickers. They use kit
  tokens, `useKitMotion`, `Segmented`, `Tint`, `Kbd`, `InlineComposer`,
  `Skeleton`, `ProgressLine`, `EmptyState`, `ThreadChip`, `StatusDot` and the
  handoff (`useHandoff` + `HandoffSheet` with a custom "Start work" trigger,
  `SentChip`).
- **Keys**: board `j/k/h/l` or arrows, Space pick up/drop, Enter open, `n`
  new task in the focused lane, `s` start work, `/` search, `f` filter, `p`
  project, `v` board or list, `?` shortcuts. Task panel: `s` start work, `r`
  rename, `e` edit description, `c` comment.
- **Selected card** uses `bg-surface-selected/70` and a plain border; the host
  focus ring stays the only strong outline.
- The header actions are sized with viewport breakpoints: bb shrink-wraps
  `headerContent`, so a `@container` there collapses to zero width.
- **Handoff landing**: the kit flies a "thread" handoff to that thread's
  sidebar row, but bb marks only top-level rows (`data-sidebar-thread-id`),
  and the sidebar is a drawer in the compact layout. Otherwise the kit falls
  back to any `[data-kit-handoff-row="<threadId>"]`, so every linked-thread
  row in the task panel carries that marker, and while a handoff is in the
  air a provisional "Linking" row for the target thread appears there (the
  target is read from the kit's `pluginMetadata(items, target)` call).
- **Live chat is read-only** (`ThreadChat variant="timeline"`): with the
  compact composer, opening a task put the caret in the agent's composer,
  and a keystroke meant for the board went to the agent. The thread chip
  opens the thread to reply.
- **Header tiers** come from the page body's measured width (ResizeObserver
  into the view store), not the viewport: at 1000 px and up everything
  shows; from 700 px labels drop; below that the Board/List switch is left
  to its V key. With the task panel open the page is often under 700 px.
