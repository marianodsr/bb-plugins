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
  completion. Debounced: `editor/reload`; then `changes/set` built from the
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
  `helix_query` (the `lsp/query` kinds), `helix_changes` (set the walk list
  explicitly). `agents.configure` adds a short instruction saying the
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
