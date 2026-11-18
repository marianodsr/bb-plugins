# The file tree in Helix Bridge, native

The owner's words (2026-11-18): no more yazi for the tree inside bb. A new
tree, made for bb, that shares the rail. Very fast and snappy. With icons.
It can do what yazi does at least for: new files, new folders, moving
around, search with `/`, and copy and paste of files. Then, the same day:
"be original, do not copy yazi; I only want the same functionality", and
"use a style that is not a terminal's".

So this is a piece of bb's own interface, designed for this rail, not a
terminal program redrawn: bb's type and surfaces, real fields, real
buttons, a pointer that works as well as the keyboard. yazi is only the
list of things it must be able to do.

The standing rules still bind: the editor is for the user (no agent tools,
no context), nothing scans or watches the repository on a timer, keys are
plain keys in the rail and `space` + a key in Helix (never Cmd+Option or
Cmd+Shift; a plain Cmd key that every Mac app has, like Cmd+C, is fine), a
summoned panel closes when something is chosen from it, and the rail
remembers where it was. The repository this is for is a very large Bazel
monorepo, mostly Go: nothing may walk it.

## What it is

The rail's Files tab stops being a terminal running yazi and becomes an
expandable tree of the thread's workspace that the plugin draws.

```
 Files   Changes 3   Comments 1
 ┌───────────────────────────────┐
 │ (search) Search files      /  │  (+file) (+folder)
 └───────────────────────────────┘
  v services
    v auth
        [go] session.go        M
        [go] token.go
    > billing
  > web
    [bz] BUILD.bazel
 ─────────────────────────────────
  2 copied. P pastes into auth   x     (only while something is pending)
```

### What it does, and how

- **Moving.** `j` `k` and the arrows; `h` and `l` (and the left and right
  arrows) close and open a folder, or go to the parent and to the first
  child; `g g` and `G`, Home and End; `Ctrl-d` `Ctrl-u`, Page Up and Down.
  Enter (or a double click) opens a file in Helix, and the rail closes
  unless `treeStaysOpen`; on a folder it opens or closes it. A click puts
  the cursor on a row; a click on a folder also opens or closes it.
- **Search.** `/` puts the keyboard in the search field at the top. Typing
  narrows the tree to the entries that match (smart case, the parts of the
  query in order), keeps the folders that hold them, and marks the matched
  letters in each name. Down or Enter goes into the results; Escape clears
  the search and puts the cursor back where it was. It searches what is
  loaded (every folder that has been opened), not the repository: a search
  of the whole workspace by name is a later step and must not be built now.
- **New file, new folder.** `a`, or the two buttons beside the search
  field: a new row appears in place, in the cursor's folder, with a field
  where the name goes; its icon follows the extension as it is typed. Enter
  creates it, Escape removes the row. A name ending in `/` (or the folder
  button, or `A`) makes a folder; `a/b/c.go` makes the folders on the way.
  The cursor lands on what was made.
- **Rename.** `r` or F2: the row's name becomes a field in place, the name
  without its extension selected.
- **Copy and move.** `y` (or Cmd+C) copies the selection, or the cursor's
  row; `x` (or Cmd+X) marks it to move; `p` (or Cmd+V) pastes into the
  cursor's folder. While something is waiting to be pasted, a strip at the
  foot says what and where it would go, with a way to drop it; rows marked
  to move are dimmed. A taken name gets `_1` before its extension.
- **Selecting several.** Space toggles the row and goes down; Shift with
  `j` `k` or the arrows extends; Cmd-click and Shift-click with the
  pointer. Escape drops the selection.
- **Trash and delete.** `d` or Backspace asks in a bar at the foot, in
  words ("Move session.go to the trash?"), with the two answers as buttons
  that have keys (Enter and Escape). `D` deletes for good and looks like it.
- **Dot files.** `.` shows or hides them (also in the row menu).
- **Paths.** `c` copies the row's path to the clipboard.
- **The row menu.** A right click (or the menu key) on a row offers the
  same things by name: New file, New folder, Rename, Copy, Cut, Paste,
  Copy path, Move to trash. Every item shows its key.
- **Leaving.** Escape steps back one thing at a time (a field, the search,
  a pending paste, a selection) and then closes the rail, back to Helix.
- The rail's own keys (`1` `2` `3`, `?`, `C`) keep working whenever no
  field is taking text.

"The cursor's folder" is the folder the cursor is on when it is open, else
the folder that holds the cursor's row.

### How it looks

- bb's interface type for names, not the code font; rows of one fixed
  height; depth shown by indentation with hairline guides; a chevron that
  turns for folders. Hover, cursor and selection are three different,
  quiet states (host tokens). The cursor's row is plain to see from across
  the room.
- Files of the review that is active (the Changes tab's data, already in
  memory: `useChanges`) carry their status letter in the review's colours.
  No git of the tree's own.
- Dot files are hidden until asked for, and quieter when shown. A link has
  a small mark.
- Empty folder, unreadable folder, a search with no match, a workspace that
  is not there: each says so in words, in place.
- Motion only where it tells something and never where it costs time: the
  chevron's turn, a new row's arrival, the paste target's brief mark. A
  folder's rows are there in the frame it opens (no height animation).
  `prefers-reduced-motion` removes all of it.

### Icons

Its own, drawn for this tree (inline SVG, like `app/rail/glyphs.tsx`): no
icon font, no table copied from yazi or from an editor's icon theme, and
nothing to load. A folder closed and open, a file, and a mark of the kind
of file that can be told apart at 16 px in a narrow rail: for example a
small tile with one or two letters (`go`, `ts`, `py`, `md`, `{}`, `sh`)
in a hue of its own, in DESIGN.md's categorical tints (kit `Tint` hues,
light and dark). The kinds a Go, Bazel, TypeScript, Python, Rust, shell,
config and docs repository meets; everything else is the plain file. The
designer decides the exact system and shows it in the screenshots.

## The tree and the agent

The owner, later the same day: "take the chance to include things only bb
has, and to interact with the LLM. For example sending files to the thread,
but go beyond that and be creative."

A file tree in an editor shows files. This one sits beside an agent that is
reading and writing those files, so it can also be the place where you
point the agent at things and where you see what it is doing. The rule
that the editor is for the user holds: every item below happens because
the user did it on a row. Nothing is added to the agent's context, and no
tool is given to it.

1. **Send to thread** (`s`, the row menu, or dragging rows onto the chat):
   the selection, or the cursor's row, becomes references in the thread's
   composer (bb's own file mentions, folders too), the chat gets the
   keyboard, and you write the rest. This is the suite's handoff: the same
   verb and the same flight to the composer as Send to thread everywhere
   else (kit/handoff).
2. **Ask** (`i`): a small box opens on the row, with the entries named, a
   field ("Ask about session.go"), and a few ready questions as chips that
   fit what is selected (a file: explain it, who uses it, write its tests,
   review it; a folder: what is in here, how do its parts fit; several:
   how do these relate). Enter sends the message to the thread now and
   opens the chat on the answer; Escape drops it.
3. **Have it written** (in the new-file field): Tab goes from the name to a
   second field, "What should it contain?". With a description, Enter asks
   the thread to write the file instead of making an empty one. The row
   stays in place as "being written" until the file exists; then Helix
   opens it, and the file watcher shows it arriving.
4. **The agent's trail**: files the agent changed carry a mark, live while
   its turn runs (the one moving thing in the tree) and steady for the turn
   before. A closed folder carries the mark of what is inside it. `t`
   narrows the tree to the agent's files and back; a chip in the bar says
   how many there are. Enter on one opens it at its first change. The data
   is what the plugin already keeps while it follows a turn: no reads of
   the repository.
5. **Review at a glance**: beside the status letter, a file of the active
   review that is not viewed yet has a dot, and one with open comments has
   their count; closed folders add up what they hold. All from the Changes
   and Comments data already in memory.
6. **New thread here** (a folder's row menu): bb's new-thread screen with
   that folder referenced, for work that belongs to one service of the
   monorepo. Only if bb's SDK lets a plugin open that screen with a draft;
   otherwise it is left out and said so.

The contract is `ThreadLink` in `app/files/types.ts`. On the server:
`filesAsk { threadId, kind: "ask" | "write", paths, text }` sends the
message (`sdk.threads.send`, queued if a turn is running) and gives
`{ ok, error }`; `agentFiles { threadId }` gives `AgentFiles`; realtime
`agent-files { threadId }` says they changed (a few times a second at
most). `mention` and `newThread` need no server: they are bb's composer
and navigation in the page.

The messages are short and say only what the user asked, with the paths
relative to the workspace. For a question: the paths, then the user's
words. For a file to write: "Create `<path>`." and the description. No
instructions about tools, no file contents.

## Fast

This is the requirement the owner named first. What it means here:

- **No round trip to move.** `j`, `k`, `h`, `l` on what is already loaded,
  find, select and yank are all local. A key to a painted frame is under
  16 ms with 5 000 rows loaded. The list is virtualised (fixed row height),
  and a cursor move re-renders two rows, not the list.
- **Folders are cached** per thread in a module store (it outlives the
  rail, which unmounts when it closes). Opening the rail draws from the
  cache in its first frame and then refreshes every open folder in one
  batched `list`. A folder opened from cache refreshes behind.
- **Prefetch.** When the cursor rests on a closed folder (about 60 ms), its
  listing is fetched, so `l` usually has it. One small request; never the
  folder's own children.
- **One request for many folders.** `list(dirs)` takes every folder to read
  in one call: restoring the open folders, revealing a deep file.
- **Nothing recursive, nothing watched.** The host reads the folders asked
  for and nothing else. The tree refreshes when: the rail opens, a folder
  opens, after its own operations, and when the server says files changed
  (see below).
- **Optimistic.** Create, rename, paste and trash show at once and are put
  right by the listing that follows; a failure is said in the strip at the
  foot and the row goes back.

Report measured numbers: `list` end to end for one folder of 200 entries
and for 20 folders at once, key to frame at 5 000 rows, rail open to first
frame from cache.

## Where things run

```
rail (app/files)  --FilesSource-->  plugin server (server.ts)  --hostCall-->  host (host/files.ts)
   tree, cache,        filesList / filesOp / filesOpen,          readdir, mkdir, rename,
   keys, icons         realtime "files-changed"                  cp, trash, rm; path checks
```

The host is the machine where the workspace is (it can be another machine
than the server): every file system call is there.

### The contract

`app/files/types.ts` is the contract, already written: `FileEntry`,
`DirListing`, `FileOp`, `FileOpResult`, `FilesSource`. The server's RPC
methods carry the same shapes:

- `filesList { threadId, dirs: string[] }` (1 to 64 folders, relative to the
  workspace, `""` is the workspace) gives
  `{ root: string, dirs: Record<string, DirListing> }`. `root` is the
  workspace's absolute path, for the clipboard.
- `filesOp { threadId, op: FileOp }` gives `FileOpResult`.
- `filesOpen { threadId, path }` opens the file in the thread's Helix (what
  `bb hx open` does, without a jump animation) and gives `{ ok, error }`.
- Realtime `files-changed { threadId, dirs: string[] | null }`: published
  after every `filesOp` (the folders it touched), and with `dirs: null` when
  bb says the thread's environment changed and at the end of an agent turn
  in it (the plugin already receives both; at most once a second per
  thread). No watcher of the repository.

### Safety (host)

- Every path is relative, has no `..` part, no empty part, no NUL, and is
  resolved against the workspace root the server gives (the thread's own,
  from `service.threadInfo`). Absolute paths and anything that leaves the
  root are refused.
- Reading may follow a link out of the workspace (Bazel's `bazel-bin`,
  `bazel-out` are links to its output base): listing is allowed.
- Changing never happens outside it: before create, rename, copy, move,
  trash and delete, the real path of the parent folder of every source and
  destination must be inside the real path of the root. The root itself and
  `.git` (the entry, and anything under it) cannot be renamed, moved,
  trashed or deleted.
- Nothing is ever replaced: create and rename fail on a taken name; copy
  and move take the next free `name_1.ext`.
- Copy does not follow links (a link is copied as a link) and refuses to
  copy a folder into itself.
- Trash: on macOS a move into `~/.Trash` under a free name (the same volume
  only; say so when it is not). Elsewhere `gio trash` when it exists, else
  an error that says `D` deletes for good. Delete is `rm -r` on exactly the
  paths given, after the same checks.
- A `list` returns at most 5 000 entries of a folder and says `truncated`.
- No shell: `node:fs` calls and `execFile` with argument arrays only.

## What goes away

Inside bb: the yazi terminal session, its generated configuration and
opener (`host/yazi.ts`, `server/tree.ts`, `app/surface/TreePane.tsx`, the
`treeTerminal` / `treeReveal` / `treeClose` RPC, the `yaziPrepare` /
`yaziEmit` host calls, the doctor's yazi check, `bb hx tree-open`), and the
in-page tree code in `EditorSurface` that nothing uses. `space e`
(`:bb-files`) keeps its meaning: the rail on Files, on Helix's file.
Outside bb, in a plain terminal, `:bb-files` still runs yazi full screen;
that is the fork's `file-manager` setting and is not touched.

This removal is the integration step, after both halves are in.

## Split of the work

Two threads, then integration by the coordinator.

1. **Host and server** (its own worktree, branch `helix-files-host`):
   `host/files.ts`, the host contract, the server contract and handlers,
   the realtime event, tests against a temporary folder, the latency
   numbers. It does not touch `app/` and does not build or reload the
   plugin in bb.
2. **The tree** (the main checkout, branch `helix-bridge`): everything
   under `app/files/`, the rail memory for it, a preview route
   (`/plugins/helix-bridge/editor/~files`) on an in-memory `FilesSource`,
   tests of the keyboard flows on the same fake, screenshots in light and
   dark. It does not touch `server.ts`, `server/`, `host.ts`, `host/`,
   `shared/`, and does not wire the tree into the rail's Files tab.
3. **Integration** (coordinator): merge, the RPC-backed `FilesSource`, the
   Files tab on the new tree, yazi out, the docs, a release if the fork
   changes (it should not).
