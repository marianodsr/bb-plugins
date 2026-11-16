---
name: task-board
description: Read and update the user's Task Board (a kanban of tasks per bb project) with `bb tasks` or the tasks_ tools. Use when the user mentions tasks, the board, a tsk_ id, or asks to track, move, or comment on work.
---

# Task Board

Each bb project has a board of lanes. Default lanes and their kinds:
To do (`todo`), In progress (`doing`), Review (`review`), Done (`done`).
Wherever a lane is asked for, pass its id (`lan_…`), its name, or its kind.
Task ids look like `tsk_` plus 10 letters or digits.

## In a thread linked to a task

The thread's instructions include the task as quoted data, and the `tasks_`
tools are available. Their `taskId` defaults to the linked task.

- `tasks_get`: the task's current text, lane, threads and recent activity.
- `tasks_move` with `lane: "doing"` when you start, if it is still in to-do.
- `tasks_move` with `lane: "review"` and a `comment` when the work is ready
  for the user: say what changed and how to check it. Leave `done` to the user.
- `tasks_comment` for blockers or decisions the user should see on the card.
- `tasks_update` to fix the title, description, priority or labels.
- `tasks_list` and `tasks_create` for other tasks on the same board.

Tools act only on tasks in the thread's own project.

## From any shell: `bb tasks`

The project defaults to the current thread's project; pass `--project proj_…`
otherwise. Every command takes `--help`; most take `--json`.

```sh
bb tasks list                                 # open tasks in lane order, 25 per page
bb tasks list --lane review --offset 25       # next page of one lane
bb tasks list --query login --all-projects
bb tasks show tsk_abc123defg                  # description is cut at 4000 chars; --full for all
bb tasks create "Fix flaky login test" --body "Steps…" --lane todo --priority high --label auth
bb tasks create "Follow-up: retry queue" --link   # and link it to this thread
bb tasks move tsk_abc123defg review --comment "Done; run npm test to check"
bb tasks move tsk_abc123defg doing --after tsk_zzz999yyyy
bb tasks comment tsk_abc123defg "Blocked on the API key"
bb tasks update tsk_abc123defg --title "New title" --label auth,ui
bb tasks link tsk_abc123defg [--thread thr_…]  # defaults to this thread
bb tasks unlink [--thread thr_…]
bb tasks current                               # the task this thread is linked to
bb tasks lanes
bb tasks archive tsk_abc123defg                # unarchive brings it back
```

Limits: titles 200 characters, descriptions 50,000, comments 10,000, at most
10 labels of 32 characters. Lists page at 25 by default (`--limit` up to 100).

## The board in bb

The user works the same board on the Task Board page: cards per lane, a task
panel with its threads and live chat, and "Start work", which sends the task
to a thread, links it, and moves a to-do card to In progress. Your moves and
comments appear there at once; a card you move travels to its new lane.

## Linking

A thread works on at most one task; a task can have many threads. Linking a
thread that is already on another task moves it. A link made while a thread's
session is running gives it the tools and task text from its next session
start. Links follow bb: archiving a thread keeps its link, deleting it removes
the link.
