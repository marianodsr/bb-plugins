# Helix Bridge plugin

The bb half of the Helix bridge. The editor half is a fork of Helix at
`/Users/marianodsr/projects/helix-bb` (branch `bb-bridge`). Its
`bb-bridge/PROTOCOL.md` is the wire contract and
`bb-bridge/ARCHITECTURE.md` the overall design; read both.

| | |
|---|---|
| Package | `bb-plugin-helix-bridge` |
| Id | `helix-bridge` |
| Display name | Helix Bridge |
| CLI | `bb hx` |
| Tool prefix | `helix_` |

## What it does

- **Runs Helix beside a thread.** A "Helix" tab starts the fork (`hxb`, path
  in a setting) in a bb terminal scoped to the thread, so it opens in the
  thread's workspace with the thread's `BB_*` variables.
- **Finds Helix anywhere.** It also connects to instances started in any
  other terminal on the same machine, and maps them to bb threads.
- **Editor to agent.** `:bb-send` in Helix puts the selection (path, lines,
  code, note) into the thread's composer as a draft; `:bb-send!` and
  `:bb-ask` send it.
- **Agent to editor.** When bb reports file changes in the environment, and
  when a turn ends, the plugin reloads Helix's buffers and gives it the list
  of changed hunks to walk. Agents can open a location in the user's editor.
- **Static analysis for agents.** Tools that query the language server Helix
  already runs (definition, references, implementations, hover, symbols,
  call hierarchy, rename preview) and read its diagnostics, so the agent
  sees what the user sees without a second language server.

## Parts

### Host entry (`host.ts`)

Runs on the machine where Helix runs (bb's host RPC; see "bb.hosts" in the
plugin authoring references).

- Scans `<cache>/bridge/*.json` (default `~/.cache/helix/bridge`), connects
  to each socket, says `bridge/hello`, subscribes to events, and removes
  stale registry files.
- One connection per instance, reconnect with backoff, requests with ids,
  timeouts and `$/cancel`, lines up to 8 MiB.
- Keeps the worker alive while any instance is connected (worker lease) and
  watches the registry directory for instances appearing and leaving.
- Contract methods: `instances`, `call(instanceId, method, params,
  timeoutMs)`. Events go to the server as host signals, coalesced so a burst
  of selection events cannot flood it.

### Server (`server.ts`)

- **Instance registry** with each instance's bound thread:
  1. `env.BB_THREAD_ID` from the registry file;
  2. an explicit binding (`bb hx bind`, or the app's picker);
  3. the bb environment whose path contains the instance's workspace root,
     then the most recently active thread in it.
- **Follow the agent.** Subscribes to bb's environment change events and turn
  completion. Debounced: `editor/reload`; then `locations/set` (list `changes`) built from the
  bundled Git plugin's changed files and hunks (uncommitted, plus what the
  turn committed). Shows `skippedModified` paths to the user rather than
  forcing.
- **Send to thread.** `event/send` becomes a composer draft through the app
  when that thread's composer is on screen, otherwise a queued draft the app
  inserts when the thread is next opened; `sendNow` uses `threads.send`.
  The message is a compact block: path and lines, the code fenced with its
  language, the note. Unsaved-buffer sends say so.
- **RPC contract** with tags for the app: instances, state, bindings,
  settings status.
- **CLI `bb hx`**: `list`, `state`, `open <path[:line[:col]]>`, `reload`,
  `selection`, `diagnostics`, `query <kind> …`, `bind`, `unbind`, `doctor`
  (checks the fork binary, the socket directory and the protocol version).
- **Agent tools** (bounded output, offered only when an instance is bound to
  the calling thread's environment):
  `helix_selection` (what the user has selected or is looking at),
  `helix_open` (show the user a location), `helix_diagnostics`,
  `helix_query` (the `lsp/query` kinds), and the editor-driving tools in
  "The agent drives the editor" below. `agents.configure` adds a short instruction saying the
  editor is connected and when each tool is the right one.
- **Settings**: path to `hxb`, auto-reload on/off, follow-agent on/off.

### App (`app.tsx`)

Follows `docs/DESIGN.md` and uses the shared kit.

- **Helix tab** on threads: starts or focuses the Helix terminal for that
  thread. The terminal itself is bb's; the plugin adds no chrome over it.
- **Status** in the thread context card: connected or not, focused file,
  error and warning counts, the bound instance, a control to rebind.
- **Send receipt.** When a draft arrives from Helix, the kit's handoff shows
  it landing in the composer with a "From Helix" chip.
- **Setup state** when the fork binary is missing, with the one command to
  build it.
- Palette commands: open Helix for this thread, reload Helix buffers, bind
  this thread to an instance.

## Requirements added by the user

The acceptance criteria are listed at the top of the fork's
`bb-bridge/ARCHITECTURE.md`. For the plugin they mean:

### The editor is a full work surface

The user will work in Helix all day inside bb and add a file tree later. A
narrow side-panel tab is not enough.

- Helix must be usable at full width and height: as the main area of a page,
  or a maximised panel, whichever bb allows. Find out what bb offers and
  choose the surface that gives Helix the most room with the thread still
  one key away.
- **Every key reaches Helix.** Escape, Ctrl and Alt/Option chords, function
  keys, and the keys bb itself binds must arrive while the editor has focus.
  Before building UI, run a spike in bb's own terminal with a key-echo
  program and report a matrix of what arrives, what bb swallows, and what is
  mangled (Option as Meta on macOS matters: Helix uses Alt bindings). Also
  measure key-to-paint latency, true colour, mouse, resize and paste.
- If bb's terminal cannot pass the keys or is visibly slow, say so with the
  numbers; the fallback is a terminal surface owned by the plugin, which is a
  bigger piece of work the coordinator will decide on. Do not start it
  unasked.

### Decision: the editor surface is ours, on Ghostty's terminal core

The user asked for the terminal that runs Helix inside bb to be Ghostty. The
Ghostty application cannot be embedded in bb's window, but Ghostty's terminal
core runs in the browser as WebAssembly, so the plugin owns the editor
surface:

- **Session**: still a bb terminal (`bb.sdk.terminals.create`, scoped to the
  thread, running `hxb`), so bb keeps the process alive across reloads and
  the thread's `BB_*` variables are set.
- **Attach**: the app connects to that session's own stream, the way bb's
  terminal does (`/ws/terminals/<id>`, or the SDK's attach API if the
  installed SDK has one; check the typings first).
- **Render**: Ghostty's core. Two candidates: `ghostty-web` (Coder; canvas
  renderer, xterm.js-style API) and `@wterm/ghostty` with `@wterm/dom`
  (Vercel; DOM renderer). Build a thin adapter so the renderer can be
  swapped, measure both and bb's stock terminal with Helix on a large Go
  file, and keep the fastest that renders correctly. Report key-to-paint
  latency (p50, p95), full-screen redraw time, memory, and the key matrix.
- **Keys**: the surface owns the keyboard while focused. Every key goes to
  Helix except a small, documented escape set for getting back to bb (for
  example the shortcut that focuses the composer). Enable the Kitty keyboard
  protocol if the core supports it so Alt and Ctrl chords are unambiguous;
  otherwise make Option send Meta. bb's own shortcuts must not fire while
  the editor has focus.
- **Placement**: the editor fills the thread's work area. bb has
  `experimental_primarySurface` for a plugin surface that takes the thread's
  main area with the chat collapsed; check the installed SDK, and otherwise
  use a full plugin page or a maximised panel tab. The thread stays one key
  away, and the chat can sit beside the editor in a split.
- **Look**: read the user's Ghostty config read-only
  (`~/.config/ghostty/config`: font family, size, theme) and match it, with
  plugin settings to override. Bundle a symbols font only if needed.
- **Clipboard, mouse, resize, focus reporting, true colour, bracketed
  paste, OSC 52**: all must work; Helix uses them.

`upstream/wterm/` holds a snapshot of a store plugin (MIT) that attaches to bb
terminals and renders with `@wterm/ghostty`. Read it to learn how the SDK
pieces fit; write our own.

### The agent drives the editor

The user asks things like "take me to the entry point of X" and expects to
land on the line, in a pane the agent chose. The agent also has full control
of the editor (PROTOCOL.md: `editor/open`, `locations/set`, `view/*`,
`editor/select`, `editor/applyEdits`, `editor/command`).

Tools, all offered only when an instance is bound to the calling thread:

| Tool | Does |
|---|---|
| `helix_show` | Take the user to a place: `path`, `line`, optional range, optional `split` and a one-line `note`. Reveals the editor surface in bb if it is hidden. Reports back where the user landed, or that the jump is waiting because they are typing. |
| `helix_tour` | Show several places in order, each with a note (`locations/set` list `tour`), and jump to the first. The user walks it with `:bb-next`. |
| `helix_panes` | List the panes with what each shows; focus or close one. |
| `helix_selection` | What the user is looking at or has selected, with the text. |
| `helix_query` | Language-server queries (see the static analysis section). |
| `helix_diagnostics` | Diagnostics the editor holds. |
| `helix_edit` | Apply edits to a buffer as one undoable step, for changes the user should see happen in the editor; agents still use their normal file tools for bulk work. |
| `helix_command` | Anything else: a typed command, a named command, or keys. Subject to Helix's command policy; a refusal is returned as the reason, not retried. |

- The skill and the `agents.configure` instruction teach the pattern: find
  the place with `helix_query` or a search, then `helix_show` it; use
  `helix_tour` when there is more than one stop; never use `helix_command`
  for something a structured tool does.
- `helix_show` and `helix_tour` are what a user-visible answer should end
  with when the user asked to be taken somewhere; say in one line where they
  are now.
- The command policy is Helix's (`safe` by default: no shell commands, no
  discarding unsaved work). Show the active policy in the plugin's status and
  never try to work around a refusal.
- A deferred jump (`"deferred": true`) is not a failure: tell the agent the
  user will see a prompt in the editor.

### bb always knows where the user is

- The thread shows the focused file and line live, updated from
  `event/focus` and `event/selection`, with no bb write per event.
- Messages the user sends from a thread with a bound Helix can carry the
  editor position (file, line, selected range) automatically. Default on,
  with a visible toggle in the composer. Find the right SDK mechanism (a
  composer contribution, a mention, or the dispatch hook) and keep it to one
  short line of context, not the file's text.
- `helix_selection` gives an agent the same thing on demand, with the text.

### Select, comment, send

`event/send` has four kinds (PROTOCOL.md):

- `send`: selection becomes a draft in the composer.
- `ask`: sent at once with the question.
- `comment`: a review comment on the selected lines, kept until flushed.
  When the Review Editor plugin is installed, create it there through its
  RPC (`plugins/review-editor/server/contract.ts`) so Helix comments and
  Review Editor comments are one list with one agent loop. Otherwise keep a
  simple pending list in this plugin.
- `flush`: send all pending comments to the thread through the same handoff
  the Review Editor uses.

When the fork gains `annotations`, show each comment and the agent's reply
under its lines in Helix, and clear them when resolved.

## Build order

1. Host entry and server against a mock bridge (a small Node script that
   implements PROTOCOL.md, including events, slow answers and overflow), with
   tests. CLI and tools. No real Helix needed.
2. App.
3. Integration against the real fork when its step 1 lands, then the
   reload, changes and language-server features as the fork gains them.
   Capabilities come from `bridge/hello`; never assume one.

## Things to get right

- The socket is on the machine where Helix runs, which may not be the bb
  server machine. All socket work is in the host entry.
- Events are high-frequency. Coalesce in the host, never do a bb write per
  selection event, and keep the app's live reads cheap.
- Tool output is for an agent's context: locations as `path:line` with the
  preview line, capped counts with "N more", no raw protocol JSON.
- Do not modify the user's Helix config. The plugin can print the keymap
  lines to add; it does not write them.
