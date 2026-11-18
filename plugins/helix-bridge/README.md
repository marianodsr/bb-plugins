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
none. The tools still exist for those who want them: the setting
`agentTools` names them (`show, tour, selection, query, diagnostics, review,
edit, panes, command`; empty by default; `skills/helix-bridge/tools.md`
covers them).

## The editor page

Helix fills the page, and bb's sidebar stays bb's. The rail is a sheet over
the editor's left edge that is there only while you use it: a key in Helix
opens it with the keyboard, and choosing a file, a change or a comment (or
Escape, or a click outside) closes it and puts you back in Helix. It
remembers where it was, per thread: opened again it is on the same tab, on
the same file or comment, with the same filter and folders, and the
keyboard is there. It has the
thread (and the other threads that have an editor) at the top, then three
tabs:

- **Files**: the workspace's tree (`space e`), drawn by the plugin: see
  "The file tree" below. Enter opens a file, closes the rail and hands the
  keyboard to Helix (the setting `treeStaysOpen` keeps it).
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
- **Comments**: every comment of the thread's review, grouped by file, with
  the quoted lines as highlighted code numbered as in the file, its state
  (not sent, sent, answered, resolved by the agent) and severity as coloured
  chips, and the agent's replies as Markdown. Enter shows the lines in Helix; `e` edits, `d d`
  drops, `r` replies, `a` acknowledges the agent's resolution, `o` reopens.
  The tab's count is what needs you (else what waits to be sent).

**Writing a comment.** Select lines in Helix and press `space u c`
(`:bb-comment`): inside bb a box opens
beside the selection with the quoted lines, a multi-line field with voice
input and the severity. Enter keeps it, ⌘Enter keeps it and sends, Escape
cancels; Helix gets the keyboard back in the mode it was in. Outside bb,
Helix's own one-line prompt opens as before.

**Send to thread** (the bar, `space u C` in Helix, `C` in the rail) hands every comment not
sent yet to the thread, naming the review; they gather and fly to the chat's
composer (to the thread at the top of the rail when the chat is closed).

A quiet bar above Helix carries what the rail does not show: the review and
how much of it is viewed (when the Changes tab is not on screen), the pull
request, the inline diff switch, Send to thread and End review.

### Keys

Everything is `space` and a key, pressed in Helix. The plugin binds none of
bb's shortcuts (no Cmd, Option or Control chords): the keys below are Helix
bindings in your own `config.toml`, each running `:bb-emit <action>` or a
`:bb-` command. The fork's `bb-bridge/config/keys-bb.example.toml` has the
whole set to copy; the hints in the plugin name these keys.

| In Helix | Does | Runs |
|---|---|---|
| `space e` | The rail on Files, on Helix's file | `:bb-files` |
| `space u r` | The rail on Changes (starts the review) | `:bb-emit rail.changes` |
| `space u m` | The rail on Comments | `:bb-emit rail.comments` |
| `space u u` | Show or hide the rail, on the tab it was on | `:bb-emit rail.toggle` |
| `space u f` / `space u F` | Next / previous changed file, at its first change | `:bb-emit review.next-file`, `review.prev-file` |
| `space u v` | Mark Helix's file viewed and go to the next one not viewed | `:bb-emit review.viewed` |
| `space u d` | Inline diff on or off | `:bb-diff` |
| `space u c` | Comment on the selection | `:bb-comment` |
| `space u C` | Send to thread | `:bb-emit review.send` |
| `space u s` | Selection to the chat's composer | `:bb-send` |
| `space u t` | The chat (opens the panel, focuses its composer) | `:bb-emit chat.focus` |

| Outside Helix | Does |
|---|---|
| Escape, in the rail or the chat | Back to Helix (the rail closes) |
| `1` / `2` / `3`, in the rail | Files, Changes, Comments (not while a field is taking text) |
| `C`, in the rail | Send to thread |
| `?`, in the rail | Every key of the tab, and the Helix keys above |

Every action is also a palette command ("Helix: …"), and bb's Keyboard
settings can bind any of them, including "Helix: open the editor for this
thread", which has no key of its own (the Helix button in the thread's
header opens it).

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
e = "@:bb-files<ret>"                 # the file tree

[keys.normal.space.u]
c = "@:bb-comment<ret>"                 # comment on the selection
s = "@:bb-send<ret>"                    # selection to the thread's composer
C = "@:bb-emit review.send<ret>"        # send the comments that are waiting
f = "@:bb-emit review.next-file<ret>"   # next changed file
F = "@:bb-emit review.prev-file<ret>"
v = "@:bb-emit review.viewed<ret>"      # viewed, and on to the next
d = "@:bb-diff<ret>"                    # inline diff on or off
u = "@:bb-emit rail.toggle<ret>"        # the rail, on the tab it was on
r = "@:bb-emit rail.changes<ret>"
m = "@:bb-emit rail.comments<ret>"
t = "@:bb-emit chat.focus<ret>"         # the chat (Escape there comes back)
n = "@:bb-next<ret>"                    # next place (agent changes, tour, review)
p = "@:bb-prev<ret>"
g = "@:bb-go<ret>"                      # a jump that waited while you typed

[keys.select.space]
e = "@:bb-files<ret>"

[keys.select.space.u]
s = "@:bb-send<ret>"
c = "@:bb-comment<ret>"
```

## The file tree

The rail's Files tab is a tree of the thread's workspace that the plugin
draws itself (bb's own interface, no terminal and nothing to install). It
is read folder by folder as you open them, on the machine where the
workspace is; nothing walks or watches the repository. `docs/HELIX_FILES.md`
in this repository is its design.

| Key | Does |
|---|---|
| `j` `k`, arrows | Move. `g g` and `G` (Home, End) go to the ends; Ctrl-d, Ctrl-u, Page Up and Down by half a page |
| `l` `h`, right and left | Open and close a folder; on a file `l` opens it; `h` goes to the parent |
| Enter, double click | Open the file in Helix (the rail closes), or open and close a folder |
| `/` | Search: typing narrows the tree to what matches, in the folders already opened; Escape clears it |
| `a`, `A` | New file, new folder, typed in place; `a/b/c.go` makes the folders on the way |
| `r`, F2 | Rename in place |
| `y` `x` `p` (Cmd+C, Cmd+X, Cmd+V) | Copy, mark to move, paste into the cursor's folder; a taken name gets `_1` |
| Space; Shift with `j` `k` | Select several |
| `d`, Backspace; `D` | To the trash, after a confirmation; delete for good |
| `.` | Show or hide dot files |
| `c` | Copy the path |
| Right click, menu key | The same things by name |
| Escape | Step back (a field, the search, a pending paste, a selection), then close the rail |

Only in bb, with the thread's agent (each is something you do on a row;
nothing reaches the agent otherwise):

| Key | Does |
|---|---|
| `s`, or drag rows onto the chat | Send to thread: the rows become file and folder mentions in the thread's composer, and you write the rest |
| `i` | Ask: a box on the row with a field and ready questions; Enter sends the message to the thread and opens the chat |
| Tab in the new-file field | "What should it contain?": with a description, the thread is asked to write the file; the row waits as "being written" and Helix opens the file when it exists |
| `t` | Narrow the tree to the files the agent changed: live while its turn runs, and the turn before |
| A folder's row menu | New thread here: bb's new-thread screen with the folder mentioned |

Files of the active review carry their status letter, a dot when not viewed
yet and the count of their open comments; closed folders add up what they
hold. The agent's trail comes from the turn's own events, so a file the
agent creates or removes with a shell command shows only if Helix has it
open. The tree remembers its open folders and its cursor per thread.

Changes are refused outside the workspace and inside `.git`, and nothing is
ever replaced. The trash is the system's (`~/.Trash` on macOS, `gio trash`
elsewhere).

Outside bb, in a plain terminal, `:bb-files` runs the file manager the
fork's `file-manager` setting names (yazi by default); that is the fork's
and has nothing to do with this tree.

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
