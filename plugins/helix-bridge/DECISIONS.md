# Helix Bridge decisions

Choices not settled by `docs/HELIX_BRIDGE.md` or PROTOCOL.md, taken
conservatively. Newest last.

## Host and server

1. **Instance ids are the pid** on their host; the server key is
   `<hostId>:<pid>`. A registry file whose `startedAt` or socket changed is a
   new instance. Explicit bindings are stored by host, pid and `startedAt`,
   so they end with the instance and are pruned on reconcile.
2. **Binding order**: an explicit binding wins, then the thread of the bb
   terminal Helix runs in, then the latest thread in the environment that
   contains its workspace. (Changed in step 3: the terminal's thread is the
   default, not a lock.)
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
19. **Editor position on messages** (default changed in decision 41): SDK 0.6.132 has no pre-submit hook and
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

## Step 3: the real fork

23. **bb's terminals do not export `BB_THREAD_ID`** (or the environment,
    project and terminal ids); they export `BB_TERMINAL_SESSION_ID`. The
    fork records that too (de26f772), and the plugin maps a session to its
    thread with `terminals.get`. Sessions the plugin starts also set
    `BB_THREAD_ID`, `BB_ENVIRONMENT_ID` and `BB_PROJECT_ID` explicitly.
24. **When Helix exits** the terminal stream says so at once (`exited`, with
    the session's exit code and close reason). Exit code 0 or a close from
    bb's side closes the surface and the session and puts focus in the
    thread's composer (the page goes back to the thread; the tab closes);
    anything else shows "Helix exited with code N" with the last lines left
    on the terminal's screen, Reopen and Close. bb reports exit code 0 for a
    process killed by a signal, so `panicked at` on screen also counts as a
    crash.
25. **Resize after bb's own tab**: our surface re-sends its size every time
    it gains focus, so a resize from bb's stock terminal tab for the same
    session never sticks.
26. **Kitty keyboard protocol**: bb's terminal daemon answers the device
    attributes query itself, at once, so Helix's automatic detection always
    stops before the surface can report Kitty support. With
    `kitty-keyboard-protocol = "enabled"` in Helix's config it works fully
    (Escape `CSI 27u`, Ctrl+i `CSI 105;5u`, Option chords as Kitty). Since
    the integration step the plugin sets `HELIX_KITTY_KEYBOARD=enabled` on
    the sessions it starts (the surface always speaks the protocol), so no
    config edit is needed; Helix started in another terminal keeps its own
    setting.
27. **Tools follow capabilities**: `agents.configure` offers only the tools
    whose capability a connected Helix serving the thread reports.
28. **Pane numbers**: Helix's view ids (often above 2^32) stay internal;
    people and agents see 1, 2, 3, ... per instance, in the order first seen.
29. **Stale buffers**: without `reload`, `helix_show` and `bb hx open` say
    the buffer may be stale when files changed on disk during an agent's
    turn since that Helix started.
30. **Watching the agent write**: bb's `environment:changed` fires only while
    some client shows that environment's git status, so it cannot drive
    this. While a turn runs in an environment a Helix with `reload` serves,
    the plugin long-polls the thread's `item/completed` events
    (`threads.events.wait`) and reloads exactly the files of each completed
    `fileChange`, with `reveal` and (setting "Follow the agent") `follow`.
    Measured: 7 ms from bb recording the edit to the reload reaching Helix.
    The environment-change reload waits 2.5 s while a watcher runs, so it
    never reloads an agent's edit first, unanimated. Granularity is one
    edit: Claude Code and ACP emit no `item/fileChange/outputDelta`, and
    Codex's is the patch tool's result text, not the patch being written.
31. **Comments in the code**: namespace `bb-review`. After every comment
    write Review Editor calls this plugin's `commentsChanged` RPC with the
    environment and path (fire and forget, only when this plugin is
    installed), and that file is re-read and re-sent at once: 34 ms from the
    write returning to the annotation in Helix, measured. Everything is also
    re-read when this plugin changes a comment and every 30 s as a fallback;
    a file is re-sent only when its items change, and everything again when
    an instance connects or opens files. Open, sent and outdated comments show with a sign, their text and
    replies; an agent's resolution shows until the reviewer acknowledges it;
    a user's resolution clears it.
32. **A comment Review Editor refuses** (its lines exist only in the unsaved
    buffer) is kept as this plugin's pending comment, with the reason on
    Helix's status line; `:bb-comments-send` sends both kinds.
33. **Shortcut**: "Helix: focus the editor" is Cmd+Shift+H (Cmd+Shift+E is
    bb's `pane.maximize.toggle`).
34. **`bb hx perf-mode normal|quiet|off --instance <pid>`** is a diagnostic
    for latency A/B runs on one instance (never picked for you): `quiet`
    folds its events without signalling bb, `off` unsubscribes it from
    every event. With the HUD on, `window.__helixHud` exposes raw samples
    (`samples()`, `outputSamples()`, `reset()`). Measured: our updates cost
    nothing visible on the key path (`spike/RESULTS.md`), so position
    updates stay as they are (coalesced 150 ms in the host, 120 ms to the
    app).

## Integration step

35. **Contract details from PROTOCOL_NOTES.md** the plugin relies on: a
    deferred result means busy in any of the fork's senses (insert mode, a
    key in the last 1.5 s, a prompt or picker open, a sequence half typed),
    and the tools say so; `helix_command` reports the `overlay` and
    `pendingKeys` a command leaves, because they make the next jump wait;
    closing the focused pane can be deferred; a refusal's message already
    names the reason, so `data.reason` is added only when it does not;
    `renamePreview` `files` is the list of paths; symbols show their whole
    `extent` when the server gives one; calls list their call sites.
36. **Reload on focus** is the fork's: wterm sends `ESC [I`/`ESC [O` when
    the textarea gains or loses focus (window switches included) once Helix
    turns focus reporting on, and Helix reloads clean buffers changed on
    disk. The plugin adds nothing.
37. **Following an edit to a file that is not open** opens it where the
    agent wrote, with `editor/reveal` and `follow`: `editor/reload` ignores
    files that are not open, and bb's diffs carry no line numbers, so the
    added block is found in the file's current text (`editor/text`).
38. **Paths under `/private`** (macOS `/tmp`, `/var`) that agents report are
    mapped back to the environment's root before reaching Helix, which keeps
    `/tmp/x` and `/private/tmp/x` as two buffers.
39. **The turn-end changes list** holds only hunks that were not in the
    uncommitted diff when the turn started (both diffs are against the HEAD
    the turn started on, so the same hunk is the same text); a turn that
    changed nothing leaves the previous list. Labels count changed lines,
    not git's context.
40. **Pane numbers** are assigned in layout order the first time a new pane
    appears, so a split made by `helix_show` gets the next number.

## After daily use

41. **The position is not sent unless asked**: `positionInMessages`
    defaults to off. Off: no chip, nothing added at submit; a button among
    the composer's actions (only while a connected Helix serves the thread)
    puts the "Helix position" pill in the draft at once, as the user's own
    edit, and takes it out on a second click. On: the chip and per-thread
    toggle of decision 19, and no button.
42. **The file tree** is yazi in its own thread-scoped bb terminal session
    ("Files"), drawn by the same renderer in a pane left of Helix on the
    editor page (not the thread's quick-look tab). Its configuration
    directory (`YAZI_CONFIG_HOME`) is generated in the host's plugin data:
    the user's keymap, theme, init.lua, package.toml, plugins and flavors are
    linked, and `yazi.toml` is a copy of theirs with `[manager] ratio = [0,
    1, 0]` and an `edit` opener added only when absent. The opener runs
    `"${BB_CLI:-bb}" hx tree-open "$@"` detached (`orphan`), so yazi never
    hides its screen; `EDITOR` is set to the same for users whose own opener
    calls `$EDITOR`. `tree-open` opens the first file with `interrupt:
    "always"` (the user chose it), the rest in the background, and tells the
    app to focus the editor.
43. **Following**: positions carry the focused file's absolute path; the
    tree asks for `ya emit-to <client-id> reveal <path>` 250 ms after it
    changes, never within 1.5 s of a key in the tree. The client id is
    derived from the thread, so it survives plugin reloads. Refs only: a
    cursor move never renders anything.
44. **Terminal replies are not keys**: yazi queries the terminal at start;
    bb's daemon answers part of it before the surface attaches, so the
    surface's own answers arrive late and yazi would read them as keys. The
    tree drops OSC/DCS strings and `CSI ?`/`CSI >` reports, cursor-position
    and window-size reports from its input.
45. **Colours**: without Ghostty colours the terminal defaults are bb's
    `--background` and `--foreground`, which are `oklch()`; the WebGL
    renderer reads only sRGB, so they are resolved through a 1x1 canvas.
    (Before this, text in the terminal's default colour was invisible on
    surfaces that rely on it, as yazi's file names did.)
46. **Pane keys**: ⌘⇧Y shows or hides the tree, ⌘⇧H moves focus between
    the panes (both free in bb's keymap). The editor sends its size while
    focus is anywhere in the surface, because the tree changes its width.
    Quitting yazi (any exit) closes its session and hides the pane; Helix
    exiting closes the tree.
47. **Ghostty's font style** reaches both renderers through an alias
    family: its normal weight is the base face (`font-style`, say Bold) and
    its bold weight `font-style-bold` (else the family's Bold, the same face
    when the base is Bold, as in Ghostty), by `local()` full and PostScript
    names that the host resolves with fontconfig (`fc-list`), with name
    guesses without it. wterm's WebGL atlas asks for "<bold?> <size>px
    <family>" and had no base weight, so it drew Regular. The faces are
    loaded before the first glyph is rasterised and the surface switches to
    the alias if it loads later. Measured (spike/font-check.mjs, ink per
    cell, Bold against Regular): WebGL 1.358 editor / 1.090 tree, DOM 1.368 /
    1.088. `bold-is-bright` moves bold cells in palette 0-7 to 8-15 at the
    cell source (both renderers). The plugin's `fontStyle` setting overrides
    Ghostty's `font-style`.
48. **Whole-pixel cells**: the WebGL renderer samples its atlas with
    NEAREST at col x charWidth x dpr; a fractional product doubles or drops
    glyph columns (jagged text). letter-spacing rounds the advance to whole
    device pixels and the row height is rounded too; both are redone when
    the pixel ratio changes (another display, scaling, zoom), with a
    repaint. Layout works in 1/64 px, so at 1.5x and 3x a small drift
    remains. Measured (spike/dpr-check.mjs, mismatch between copies of one
    glyph, 0 = identical): before 0.217 / 0.124 / 0.022 / 0.067 at 1x, 1.5x,
    2x, 3x; after 0 / 0.021 / 0 / 0.006; DOM 0 / 0.028 / 0 / 0.
49. **Diagnosable**: with the HUD on it shows the renderer, the font in
    use (and whether it is the requested face), the pixel ratio and the cell
    in device pixels. A family not installed on the computer running bb's
    app (or a face that did not load) shows a one-line notice under the
    editor.
