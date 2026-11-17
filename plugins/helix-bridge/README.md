# Helix Bridge

The bb half of the Helix bridge: Helix (the `hxb` fork) beside a thread, on
bb's terminal sessions rendered with Ghostty's core; sends, comments and the
editor position from Helix to the thread; reloads and change lists from the
agent to Helix; `bb hx`, and a skill that takes the user to code. The wire contract is
`bb-bridge/PROTOCOL.md` in the fork (github.com/marianodsr/helix, branch
`bb-bridge`). Agent-facing usage is in `skills/helix-bridge/SKILL.md`;
choices are in `DECISIONS.md`.

## Install

```sh
bb plugin install git:https://github.com/marianodsr/bb-plugins.git@main --subdirectory plugins/helix-bridge
bb hx doctor        # what is missing on this machine, with the command for each
```

The editor is `hxb` on PATH (setting `hxbPath` overrides). The bridge
directory follows Helix: `$XDG_CACHE_HOME/helix/bridge` or
`~/.cache/helix/bridge` (setting `bridgeDir` overrides).

## Agents

An agent hardly needs to know about Helix: the files and lines you mean
arrive in your message (`:bb-send`, comments), it edits files with its own
tools and Helix shows the change, and it uses its own language server for
static analysis. So threads get no Helix tools and no instruction by
default; the only standing context is the `helix-bridge` skill's one-line
listing. When you ask "take me to ..." or "walk me through ...", the skill
loads and the agent runs:

```sh
bb hx open internal/auth/session.go:42-58 --note "token refresh starts here"
bb hx tour --title "Request flow" "cmd/server/main.go:31 entry" "internal/auth/session.go:42 auth"
```

Both act on the Helix of the thread they run in, and say so when there is
none. The tools still exist for those who want them: settings `toolShow`,
`toolTour`, `toolSelection`, `toolQuery`, `toolDiagnostics`, `toolPanes`,
`toolCommand`, `toolEdit` (all off; `skills/helix-bridge/tools.md` covers
them).

## The editor page

Helix fills the page. bb's sidebar becomes the editor's rail while the page
is open: the thread (and the other threads that have an editor) at the top,
then three tabs:

- **Files**: the yazi tree (`space e` in the owner's keys, or ⇧⌘Y). Enter
  opens a file and hands the keyboard to Helix; Escape goes back to Helix.
- **Changes**: the review. Opening it starts one in Helix (the branch when it
  has commits of its own, else the uncommitted changes); the scope control
  switches between Uncommitted, Branch, PR (when the thread has one) and
  Commit (a recent commit). Files are grouped by folder with their size and
  bb's own viewed marks, shared with bb's Diff tab: a file stops counting as
  viewed when its content changes, so after the agent answers, the files it
  touched come back by themselves. `j`/`k` skim with the diff in a flyout
  (bb's diff viewer), Enter opens the file in Helix at its first change, `v`
  marks it viewed and moves on, `u` shows only what is left, `?` lists the
  keys. bb's Git plugin lists at most 500 files; the list says when it is
  cut short.
- **Comments**: your comments and the agent's replies.

A quiet bar above Helix names the review, how much is viewed, its size, the
inline diff switch and End review. ⇧⌘H moves between Helix and the rail.
When bb's sidebar is collapsed, or on a compact window, the rail opens as a
sheet over the editor.

The first time the page opens at a window size, the chat panel closes if
leaving it open would give Helix fewer than 80 columns; after that the
panel stays as you leave it, per window size. The HUD (setting `hud`)
shows Helix's columns.

`:bb-review <target>` in Helix still works (`uncommitted`, `branch`, `pr`,
`commit <sha>`, `off`; in Helix a target is one argument, so quote a commit:
`:bb-review "commit HEAD~1"`, or give a bare sha). An active review is
refreshed only when something happens: a save or a reload in Helix in that
workspace, bb's environment-change event, the end of an agent turn, or
asking for the same target again. Never on a timer. Every git read a review
makes is logged (`bb plugin logs helix-bridge`, "git read: …").

## What runs in the background

Kept small for very large repositories: nothing reads the working tree on a
timer or on every turn.

- Every 5 s the machine lists Helix's bridge directory (a few small files),
  and every 30 s the server reconciles instances and bindings. Neither
  touches the repository.
- While an agent turn runs in a workspace a Helix serves, the plugin follows
  the turn's events from bb (no repository reads) and, per edit, shows that
  file (a Helix with `watch` reloads by itself; an older one is asked to).
  The changes list at the end of the turn is built from those edits and Helix's own reloads, with one read of each
  edited file through Helix; no git.
- Git runs only for what you start: a review (`bb--git` files and diff, on
  the signals above; a file's patch when you rest on it in the Changes tab;
  the recent commits when you open the Commit scope), and `bb hx` commands
  you run.

## Keys in Helix

The bridge's commands have no keys of their own; bind them in
`~/.config/helix/config.toml`. Write them as macros (`"@:command<ret>"`):
Helix refuses a whole config that names a typed command it lacks, so a plain
`":bb-files"` would make a stock `hx` reject the file, while a macro is only
looked up when pressed. The full suggested set is
`bb-bridge/config/keys-bb.example.toml` in the fork; the essentials:

```toml
[keys.normal.space]
e = "@:bb-files<ret>"          # the file tree beside the editor

[keys.normal.space.t]
s = "@:bb-send<ret>"           # selection to the thread's composer
c = "@:bb-comment<ret>"        # comment on the selection
C = "@:bb-comments-send<ret>"  # send the pending comments
n = "@:bb-next<ret>"           # next place (agent changes, tour, review)
p = "@:bb-prev<ret>"
g = "@:bb-go<ret>"             # a jump that waited while you typed

[keys.select.space]
e = "@:bb-files<ret>"

[keys.select.space.t]
s = "@:bb-send<ret>"
c = "@:bb-comment<ret>"
```

## The file tree

With [yazi](https://yazi-rs.github.io) installed (`brew install yazi`; `bb hx
doctor` checks), the editor page has a file tree beside Helix. It works as a
picker: choose a file (Enter, or your opener key) and it opens in Helix and
the tree closes, with you in the editor (setting `treeStaysOpen` keeps it
showing). Escape or `q` closes it too. While it shows, it follows the file
you are in, unless you are moving in the tree right then.

| Keys | |
|---|---|
| `space e` in Helix (`:bb-files`) | open the tree on the file you are in, focused |
| ⌘⇧Y | show or hide the tree (also the folder button in the page header) |
| ⌘⇧H | move focus between the tree and the editor |
| Escape or `q` in the tree | close the tree, back to Helix |

Drag the divider to resize; width and visibility are remembered in this
browser (the tree starts hidden on narrow windows). Your own yazi
configuration applies (keymap, theme, plugins, `yazi.toml`) and is never
written: the tree runs with a generated configuration directory in the
plugin's data that links yours and adds one column and the "Open in Helix"
opener only when your `yazi.toml` does not set them. Quitting Helix closes
the tree.

## Your position in messages

Messages carry nothing about where you are in Helix unless you ask. The
target button among the composer's actions (shown while a Helix serves the
thread) attaches your file, line and selection to the message you are
writing; click it again to take it out. To send it with every message, turn
on `positionInMessages` (`bb plugin config helix-bridge set
positionInMessages true`): a chip above the composer then shows the position
and toggles it per thread. Agents can read it any time with
`helix_selection`.

## Layout

| Path | |
|---|---|
| `host.ts`, `host/` | host entry: registry scan and watch, one socket per instance, events folded into coalesced signals, doctor, Ghostty config |
| `server.ts`, `server/` | bindings, sends and comments, follow the agent, `bb hx`, tools, the app's RPC |
| `shared/` | the protocol's types and the host contract |
| `app.tsx`, `app/` | editor page and tab, terminal stream, renderer, key layer, HUD, status, composer position button and chip, drafts |
| `assets/ghostty-vt.wasm` | the Ghostty VT core wterm loads (Apache-2.0, see NOTICE) |
| `test/mock-bridge/` | a mock Helix bridge implementing PROTOCOL.md v1, with a control socket |
| `spike/` | the renderer spike and drivers, results in `spike/RESULTS.md` |

## Build and test

```sh
npm install --include=dev
npx tsc --noEmit
npx vitest run          # binds Unix sockets: run outside a sandbox that forbids it
bb plugin build
```

## Running against the mock

```sh
node test/mock-bridge/mock.mjs --dir /tmp/hx-mock --workspace "$PWD/test/fixtures/workspace" \
  --open main.go --env BB_THREAD_ID=<a thread you choose> --control /tmp/hx-mock.ctl &
bb plugin config helix-bridge set bridgeDir /tmp/hx-mock
bb hx list
node test/mock-bridge/ctl.mjs /tmp/hx-mock.ctl '{"cmd":"select","line":10,"endLine":12}'
node test/mock-bridge/ctl.mjs /tmp/hx-mock.ctl '{"cmd":"send","kind":"send","note":"look"}'
node test/mock-bridge/ctl.mjs /tmp/hx-mock.ctl '{"cmd":"flood","count":100000}'
bb plugin config helix-bridge unset bridgeDir
```

Mock instances are marked as tests: they bind only through `BB_THREAD_ID`
or `bb hx bind`, never through their workspace. Control commands: `select`,
`edit`, `save`, `mode`, `busy`, `send` (`kind`: send, ask, comment, flush),
`diagnostics`, `externalChange`, `lsp`, `flood`, `stall` (forces an
overflow), `slow` (per-method delay; timeouts and `$/cancel`), `state`, `go`,
`crash` (leaves a stale registry file), `exit`.

## Measuring the editor surface

Turn on the HUD (`bb plugin config helix-bridge set hud true`): key-to-paint
p50 and p95 over recent keys, paint work per frame, dropped frames, the
renderer in use, and the last key as received and as sent to the terminal.
`node spike/surface.mjs --thread <threadId>` drives it in headless Chrome.
