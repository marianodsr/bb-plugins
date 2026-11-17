# Helix Bridge decisions

Choices not settled by `docs/HELIX_BRIDGE.md` or PROTOCOL.md, taken
conservatively. Newest last.

## Host and server

1. **Instance ids are the pid** on their host; the server key is
   `<hostId>:<pid>`. A registry file whose `startedAt` or socket changed is a
   new instance. Explicit bindings are stored by host, pid and `startedAt`,
   so they end with the instance and are pruned on reconcile.
2. **Binding order follows the design** (terminal, explicit, environment).
   `bb hx bind` on an instance started in another thread's terminal is
   refused with the reason, rather than overriding the terminal.
3. **Test instances**: the mock bridge writes `"test": true` in its registry
   file (not part of PROTOCOL.md). Such instances bind only through
   `BB_THREAD_ID` or `bb hx bind`, never through their workspace, and never
   serve a thread through its environment (tools, CLI target).
4. **One state signal per host, coalesced** to at most one per 150 ms
   (immediate for a send). It carries every instance's summary (focus,
   cursor, mode, counts, capabilities), so the server needs no call per
   event. Selection events cost an in-memory update in the host. The server
   republishes positions to the app over realtime at most every 120 ms and
   invalidates RPC reads only when something structural changed. No bb write
   happens per event.
5. **Sends are queued in the host** until the server acknowledges them
   (`pendingSends` / `ackSends`), so a lost signal or a server restart does
   not lose a `:bb-send`; the 30 s reconcile also drains them.
6. **The worker lease is taken inside a host call**: the SDK refuses
   `experimental_retainWorker()` outside an active call. The host takes it on
   the next call after an instance connects (the server reconciles every
   30 s, well inside the 5-minute idle window) and drops it when none is
   connected. A captured `experimental_emitSignal` keeps working after its
   call ended (verified live).
7. **Overflow**: `event/overflow` increments a counter and resyncs state with
   `editor/state` and two `diagnostics/get` totals.
8. **Diagnostics totals** come from `diagnostics/get` (errors, then
   errors+warnings, `limit: 1`) debounced 300 ms after `event/diagnostics`,
   because per-path events cannot correct a baseline from before connecting.
9. **Tools**: the eight tools of "The agent drives the editor" replace the
   earlier `helix_open` and `helix_changes` (`helix_show` and `helix_tour`
   cover them; the changes list is set by follow-the-agent). They are offered
   only to a thread a connected Helix serves; bb builds a session's tools when
   it starts, so a thread that started before Helix connected gets them on
   its next session. Tool errors return the bridge error name and, for a
   command-policy refusal, `data.reason`.
10. **Follow the agent**: reload is debounced 400 ms per environment after
    `environment:changed` with `work-status-changed`. At turn end the
    `changes` list is the diff from HEAD at turn start (`bb--git diff` with
    `all` against that sha) when the turn committed, else the uncommitted
    diff; it is activated only when non-empty. Unsaved buffers are reported
    on Helix's status line and in the thread, never forced.
11. **Comments**: with Review Editor running and the file inside the
    thread's environment, `:bb-comment` creates a Review Editor comment for
    the thread; `:bb-comments-send` sends that thread's open comments with
    Review Editor's own `sendToThread`. Otherwise comments are kept in this
    plugin's SQLite and flushed as one message. Annotations (when the fork
    offers them) show unresolved comments with the latest reply.
12. **Send now** uses `threads.send` with `queue-if-active`, like the kit.
13. **Doctor** resolves the binary on the host's PATH (the daemon's
    normalized user PATH), runs `--version`, checks the bridge directory
    mode, `gopls`, `goimports`, and the Ghostty font (fontconfig when
    present, else font file names).
14. **Ghostty config**: read-only from `$XDG_CONFIG_HOME/ghostty/config`,
    `~/.config/ghostty/config`, then the macOS app-support path. No file:
    Option acts as Alt (the owner's choice). A file without
    `macos-option-as-alt`: Ghostty's own default, false.

## App

15. **The editor page** is `/plugins/helix-bridge/editor/<threadId>` with a
    fixed Chat tab (`ThreadChat`, compact) in bb's side panel. The thread's
    Helix tab is a quick look at the same session. One terminal session per
    thread, titled "Helix", started with the `hxbPath` setting.
16. **Resize ownership**: only the surface that holds focus sends resize; the
    page re-asserts focus on the editor for up to 1.6 s after opening (bb's
    chat composer takes focus when it mounts) unless the user clicks.
17. **Keys**: Cmd belongs to bb except Cmd+C with a selection (copies) and
    Cmd+V (native paste, sent bracketed). Option as Alt from
    `KeyboardEvent.code` on a US layout, so dead keys work; Kitty sequences
    when Helix has turned the protocol on. Tab and Shift+Tab are sent by the
    plugin because wterm reads Escape then Tab as "leave the terminal".
    Unhandled non-Cmd keys never bubble to bb.
18. **Look**: the terminal blends with bb (no padding or radius; default
    colours from Ghostty's `background`/`foreground` when set, else bb's).
    Font family, size and bold from Ghostty unless the plugin settings
    override them.
19. **Editor position on messages**: SDK 0.6.132 has no pre-submit hook and
    the dispatch hook cannot rewrite a message. The position is a chip above
    the composer with its toggle (per thread, remembered in this browser;
    default from the `positionInMessages` setting). On the submit gesture
    (plain Enter with no menu open, or bb's send/queue/steer button) a
    "Helix position" mention pill is appended at the end of the draft, and
    the server's mention provider resolves it into one agent-only line. The
    draft is never touched while the user types (tested key by key).
20. **Drafts from Helix** land when that thread's composer is on screen in
    any window (first window to take the draft wins); otherwise they wait.
    The "From Helix" receipt shows over the composer for 6 s; the kit's
    packet flies from the editor when it is visible.
21. **Reveal** (`helix_show`, `helix_tour`): a toast with "Show" on the
    thread's own page, never an automatic navigation.
22. **Status**: a context card row (card layout) and a context segment
    (banner layout); the segment omits the file and line because the
    composer chip right below shows them.
