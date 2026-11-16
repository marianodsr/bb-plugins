Open a workspace file, edit it, see what changed against git, and comment on
line ranges. Send the comments to a thread: its agent replies to and resolves
each one, and the replies appear beside the code.

## How it works

Files are read and saved through bb on the machine that holds the workspace,
with a guard that refuses to overwrite changes made since you opened the file.
Comments stay on the code they were written about as the file changes, and are
marked outdated when that code is gone. Comments live in this plugin's own
storage on the bb server.

## For agents

Agents get `review_list_comments`, `review_reply` and `review_resolve`, and the
`bb review` command for the same work from a shell.
