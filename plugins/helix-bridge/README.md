# Helix Bridge

The bb half of the Helix bridge: Helix (the `hxb` fork) beside a thread, on
bb's terminal sessions rendered with Ghostty's core; sends, comments and the
editor position from Helix to the thread; reloads and change lists from the
agent to Helix; `bb hx` and the `helix_*` agent tools. The wire contract is
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
