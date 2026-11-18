# The file tree in Helix Bridge, native

The owner's words (2026-11-18): no more yazi for the tree inside bb. A new
tree, made for bb, that shares the rail. Very fast and snappy. With icons.
It works like yazi at least for: new files, new folders, moving around,
search with `/`, and copy and paste of files.

The standing rules still bind: the editor is for the user (no agent tools,
no context), nothing scans or watches the repository on a timer, keys are
plain keys in the rail and `space` + a key in Helix (never Cmd+Option or
Cmd+Shift), a summoned panel closes when something is chosen from it, and
the rail remembers where it was. The repository this is for is a very large
Bazel monorepo, mostly Go: nothing may walk it.

## What it is

The rail's Files tab stops being a terminal running yazi and becomes a list
the plugin draws: an expandable tree of the thread's workspace, keyboard
first, with yazi's keys where yazi has one.

```
 Files   Changes 3   Comments 1
 ─────────────────────────────────
  services
    auth
      session.go            M
      token.go
    billing
  web
  BUILD.bazel
  go.mod
 ─────────────────────────────────
 /sess█                    2 of 5
```

### Keys (focus in the tree)

| Key | Does | yazi |
|---|---|---|
| `j` `k` / arrows | down, up | same |
| `g g`, `G` | first, last row | same |
| `Ctrl-d`, `Ctrl-u` | half a page down, up | same |
| `l` / `→` / Enter | a folder: open it (already open: go to its first child). A file: open it in Helix; the rail closes unless `treeStaysOpen` | enter / open |
| `h` / `←` | an open folder: close it. Otherwise: go to the parent folder's row | leave |
| `/` | find: type, the cursor jumps to the first row that matches as you type; Enter keeps it, Escape goes back where it was | find |
| `n`, `N` | next, previous match of the last find | same |
| `a` | create in the cursor's folder; a name ending in `/` is a folder; `a/b/c.go` makes the folders on the way | same |
| `r` | rename (the name without its extension is selected) | same |
| `y` | yank: mark the selection (or the row) to copy | same |
| `x` | mark it to move | same |
| `p` | paste into the cursor's folder | same |
| `Y` or `X` | forget what was yanked | same |
| Space | select or unselect the row and go down | same |
| `d` | to the trash, after `y` to confirm | same |
| `D` | delete for good, after `y` to confirm | same |
| `.` | show or hide dot files | same |
| `c c`, `c f`, `c d` | copy the path, the name, the folder's path to the clipboard | same |
| Escape, `q` | a selection or a yank: forget it. Otherwise close the rail, back to Helix | escape / quit |
| `1` `2` `3`, `?`, `C` | the rail's own keys keep working | |

"The cursor's folder" is the folder the cursor is on when it is open, else
the folder that holds the cursor's row.

Find is yazi's find, not a search of the repository: it looks at the rows
that are showing (every open folder), smart case, substring. A search of
the whole workspace by name is a later step and must not be built now.

### What it shows

- One row per entry: indentation by depth, a chevron for folders, an icon
  by kind of file, the name. Dot files are hidden until `.`.
- Files of the review that is active (the Changes tab's data, already in
  memory: `useChanges`) carry their status letter in the review's colours.
  No git of the tree's own.
- Yanked rows are marked (copy and move look different), selected rows too.
- The prompt line (find, create, rename, confirm) is at the foot of the
  list, one line, in the list's own type. It never moves the rows.
- Empty folder, unreadable folder, a workspace that is not there: each says
  so in a row, in words.

### Icons

yazi's own icons are Nerd Font glyphs, and the owner already has a Nerd
Font (the editor's font, from `useGhostty()`: "FiraCode Nerd Font Mono").
The tree uses the same glyphs and colours as yazi's preset theme (its
`theme-dark.toml` and `theme-light.toml`, MIT, themselves from
nvim-web-devicons, MIT; credit both in NOTICE), drawn as text in that font:
no icon files, nothing to load, and it looks like the yazi the owner knows.

When the font is not installed or lacks the glyphs (measure once, on a
canvas, and remember), the tree falls back to its own three outlines:
folder, open folder, file. It must never show empty boxes.

The table is data, generated once from yazi's theme files into
`app/files/icons.ts` (by exact name, then by extension; glyph, dark colour,
light colour). Keep it under about 15 KB of source: the entries a Go, Bazel,
TypeScript, Python, Rust, shell, config and docs repository meets, not all
of yazi's. These identity colours are the one place hex literals are
allowed (DESIGN.md "Colour" is about chrome; say so in DECISIONS).

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
  right by the listing that follows; a failure is said in the prompt line
  and the row goes back.

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
