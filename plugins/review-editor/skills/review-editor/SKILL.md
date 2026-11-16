---
name: review-editor
description: Reply to and resolve Review Editor code comments sent to your thread, or read, add and send line comments with the `bb review` CLI.
---

# Review Editor comments

A reviewer writes comments on line ranges of workspace files in Review Editor
and sends them to a thread. Each comment has an id like `rc_0123456789`, a
file path relative to the workspace root, a line range, the quoted code, a
severity (`note`, `suggestion`, `issue`, `blocker`), a state, and replies.

States: `open` (not sent yet), `sent` (handed to a thread), `resolved`, and
`outdated` (the quoted code no longer appears in the file; the comment keeps
the old quote). Comments move with their code when lines above change, so
trust the quoted code over the line numbers.

## When comments are sent to your thread

For each comment:

1. Make the change, or decide it should not be made.
2. Reply with what you did: `review_reply` `{ commentId, body }`.
3. Resolve it when it is handled: `review_resolve` `{ commentId, note? }`.
   If you need the reviewer's input, reply with the question and leave it open.

`review_list_comments` `{ state?: "unresolved" | "resolved" | "all", path? }`
lists the comments sent to this thread with their current lines and code.

The tools only act on comments sent to the calling thread. Some providers
list them as deferred tools (for example `mcp__bb-bridge__review_reply`):
load their schemas first, then call them. If the tools are not in your
session at all (they attach when a session starts), use the CLI below; it
records you as the agent when run from your thread.

Your replies and resolutions show up live beside the code in the reviewer's
editor; a comment you resolve stays visible there as "Resolved by agent",
with your note, until the reviewer acknowledges it, so keep replies short and specific: what changed, where, or the one
question you need answered.

## `bb review` CLI

The environment defaults to the calling thread's; pass `--env <id>` otherwise.
Add `--json` to any command for machine-readable output.

```sh
bb review comments [--path <file>] [--state open,sent,resolved,outdated | --all] [--snippet]
bb review comments --thread "$BB_THREAD_ID"     # comments sent to this thread
bb review show <id>                              # one comment with code and replies
bb review reply <id> --body "What I changed"
bb review resolve <id> [--note "How it was handled"]
bb review reopen <id>
bb review add <path> --lines 42-48 --body "..." [--severity issue]
bb review delete <id>
bb review prompt [ids...] [--path <file>]        # the handoff prompt, without sending
bb review send [ids...] --thread <thread-id>     # send and mark sent
bb review changed                                # changed files (git) with comment counts
bb review sync <path>                            # re-anchor a file's comments now
```

`comments`, `show` and `prompt` re-anchor comments to the current files
first. Paths are workspace-relative, without `..`. Bodies are up to 20000
characters. Lists are capped at 200 comments (the tool at 50); narrow with
`--path` or `--state`.
