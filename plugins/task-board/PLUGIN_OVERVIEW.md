A kanban board of tasks for each project, kept in bb itself.

## What you get

- A **Task Board** page with lanes (To do, In progress, Review, Done) for
  each project, and a view across all projects.
- Start a thread from a task and watch what its threads are doing from the card.
- Agents in a linked thread see their task and keep it current: they move it
  to Review and leave a note when the work is ready.
- A `bb tasks` command for the terminal and for agents in any thread.

## How it works

Tasks live in this plugin's own database on the bb server. Nothing leaves the
machine, and the plugin needs no account, API key, or external service.
