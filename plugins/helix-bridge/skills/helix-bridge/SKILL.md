---
name: helix-bridge
description: Work with the user's Helix editor through Helix Bridge - take them to code (helix_show, helix_tour), read their selection and diagnostics, query Helix's language server, edit in their buffers, or use the `bb hx` CLI.
---

# Helix Bridge

The user edits in Helix (a fork run as `hxb`) connected to bb. Each Helix
instance is bound to one bb thread: the thread whose terminal started it, an
explicit binding (`bb hx bind`), or the most recent thread in the environment
that contains its workspace. Tools act on the Helix serving your thread.

## Take the user somewhere

When the user asks to be shown something ("take me to the entry point",
"where is X handled"):

1. Find the place: `helix_query` (`definition`, `references`,
   `workspaceSymbols`, `documentSymbols`, ...) or a search.
2. `helix_show` `{ path, line, endLine?, note }` puts them on it. Use
   `split: "vertical"` to keep their current file beside it.
3. Several places in order: `helix_tour` `{ title, stops: [{ path, line, note }] }`.
   They walk it with `:bb-next` and `:bb-prev`.
4. End your answer with one line saying where they are now.

A result that says **deferred** is not a failure: the user was typing, so
Helix waits and shows "bb wants to show <file>:<line> (:bb-go)". Tell them to
run `:bb-go`. Pass `now: true` only when they asked to be moved right away.

## Read what the user sees

- `helix_selection`: the focused file, selections (or the cursor line) and
  the text, and whether the buffer has unsaved changes.
- `helix_diagnostics` `{ path?, severity? }`: what Helix's language servers
  report, errors first.
- `helix_query`: the language server Helix already runs. Positions are
  1-based line and column. Prefer it to starting another server.
- `helix_panes`: the panes and what each shows; focus or close one.

## Change the editor

- `helix_edit`: apply edits to a buffer as one undoable step the user sees
  (left unsaved unless `save: true`). Use your normal file tools for bulk
  changes; Helix reloads unchanged buffers when files change on disk.
- `helix_command`: anything else, as exactly one of `typed` (a command line
  without the colon), `static` (a command name from Helix's key maps) or
  `keys` (Helix key notation). Helix's command policy (`safe` by default: no
  shell, nothing that discards unsaved work) may refuse; report the reason,
  never retry or work around it. Do not use it for what a structured tool
  does.

Some providers list these as deferred tools (for example
`mcp__bb-bridge__helix_show`): load their schemas first. Tools are attached
when a session starts; if they are missing, use the CLI.

## From the user's side

In Helix the user runs `:bb-send [note]` (selection becomes a draft in the
thread's composer; `:bb-send!` sends it), `:bb-ask <question>` (sent at
once), `:bb-comment <text>` (a review comment on the selected lines, kept
until `:bb-comments-send` sends them all). With Review Editor installed,
those comments are Review Editor comments: reply and resolve them with
`review_reply` and `review_resolve`. When a turn ends, Helix gets the list of
places you changed; the user walks it with `:bb-next`.

## CLI

`bb hx` runs on any machine bb knows; `--instance <pid>` picks an instance,
otherwise the one serving the calling thread, or the only one.

| Command | Does |
|---|---|
| `bb hx list` | instances, where they are, their threads |
| `bb hx state` | focused file and cursor, mode, diagnostics, capabilities, command policy |
| `bb hx open <path[:line[:col]]> [--split vertical] [--note] [--now]` | show a place |
| `bb hx selection [--brief]` | the selection with text |
| `bb hx diagnostics [path] [--severity error]` | diagnostics |
| `bb hx query <kind> <path:line:col> [--query] [--new-name]` | language-server queries |
| `bb hx panes [--focus N] [--close N]` | panes |
| `bb hx command <line> \| --static <name> \| --keys <keys>` | run a command |
| `bb hx reload [paths...] [--force]` | reload changed buffers |
| `bb hx bind [--instance] [--thread]`, `bb hx unbind` | binding |
| `bb hx doctor` | what is missing on this machine and the command to fix it |

Settings (`bb plugin config helix-bridge set <key> <value>`): `hxbPath`
(default `hxb` on PATH), `autoReload`, `followAgent`, `positionInMessages`,
`hud`, `fontFamily`, `fontSize`, `bridgeDir` (empty follows Helix's cache
directory).
