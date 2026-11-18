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
50. **The tree is a picker**: opening a file from it (Enter, `l`, `o`, Right,
    or a click; detected as Helix's focused file changing within 2 s) closes
    it and puts focus in Helix, unless the `treeStaysOpen` setting is on.
    Escape (a keymap the plugin adds only when the user has no keymap.toml)
    and `q` quit yazi, which closes the pane.
51. **`:bb-files`** (`space e`): the host subscribes to `files` only for a
    Helix the plugin started in a bb terminal (registry env has both
    BB_THREAD_ID and BB_TERMINAL_SESSION_ID); anywhere else nobody
    subscribes and Helix runs its own file manager full screen. Optional
    kinds (`files`, `review`) are subscribed one per request, failures
    ignored, because an unknown kind fails a whole subscribe on older
    builds. `event/files` goes through the send queue; the editor page of
    that thread shows the tree, reveals the file and focuses it.
52. **Opening from the tree is direct**: the opener script finds the
    thread's Helix in the bridge directory and sends `editor/open` over its
    socket (macOS `nc` quits when its input ends, so the input is held open
    while the script, detached, waits for the answer); `bb hx tree-open` is
    the fallback. Measured (spike/tree-open-latency.mjs, Enter to Helix's
    first output naming the file): 39-116 ms for README.md, 93-183 ms for a
    Go file after its first open (Helix's own work for Go), against about
    830 ms through the bb CLI.
53. **`watch`**: a Helix that watches its own open files gets no
    `editor/reload` from the plugin (agent edits, the environment catch-all,
    turn end). The `item/completed` long-poll stays only for navigation:
    with "Follow the agent", a file the agent edited that is not open
    (`editor/state` says which) is opened at the edit with the reveal. A
    watch-origin `event/reloaded` during a turn of that thread moves the view
    to its first range (whenIdle); outside a turn it does nothing. The
    turn-end changes list stays git-based. Older builds keep the previous
    behaviour.
54. **Agent context**: `helix_edit` is offered only with the `toolEdit`
    setting (default off): agents edit files with their own tools and Helix
    shows it. `helix_panes` and `helix_command` have settings too (default
    on for now). Descriptions and parameters were trimmed (`helix_show` lost
    col, endCol and pane; query and diagnostics lost paging), and the
    instruction names only the tools offered. Characters always in context
    (tool schemas + instruction + skill listing): 8,365 before; 5,122 with
    the defaults now; 3,813 with the core set (show, tour, selection, query,
    diagnostics).
55. **No agent tools by default** (the owner's call): an agent needs the
    files and lines the user means (they arrive with `:bb-send` and
    comments), edits with its own tools (Helix shows it), and uses its own
    language server. Every `helix_*` tool has a setting, all off;
    `agents.configure` offers the skill and nothing else unless one is on.
    "Take me to X" and tours go through `bb hx open path:line[-endLine]` and
    `bb hx tour "path:line note" ...` (or `--stops-stdin`), taught by a
    short skill whose listing triggers on "take me to", "show me where",
    "walk me through", "open in my editor". Standing context per thread: the
    skill's listing line (description 113 characters). From a thread, the
    CLI acts only on that thread's Helix and says so plainly when there is
    none (it no longer falls back to the only Helix running). The previous
    skill text is `skills/helix-bridge/tools.md`, for people who turn tools
    on. Checked with a real agent in a fresh thread: it loaded the skill,
    searched, ran `bb hx open util.go:7-9`, and Helix landed there.
56. **Reviews** (`server/review.ts`, capability `review`): targets are
    resolved per environment. `uncommitted` is against HEAD (`base: null`);
    `branch` and `pr` use bb's Git plugin `files` with `all` against the
    base branch, whose `mergeBaseRef` is the base; `pr` takes the base
    branch from the GitHub pull-request plugin. `commit <rev>` is resolved
    and compared with its parent by read-only git on the host (`gitRead`).
    `turn` compares with the snapshot its last agent turn started from
    (`git stash create`, which writes a commit object and moves nothing; HEAD
    when clean; untracked files at the start are left out), taken only
    where a Helix that can review serves the environment. Every hunk becomes
    the `review` locations list. An active review is re-resolved after
    environment changes and Helix reloads (debounced 700 ms) and every 4 s,
    and re-sent with the same id only when it changed.
57. **Starting a review**: `:bb-review <target>` (event/review through the
    send queue), `bb hx review [target]`, the editor page's review control
    and the palette command "Helix: review changes in the editor" (the same
    dialog: targets, a commit field, the active review with its open
    comments, Send comments, End review), Review Editor's "Open in Helix"
    (thread-scoped: never another thread's Helix), and `helix_review`
    (setting `toolReview`, off).
58. **The handoff names the review**: with a review active, comments sent
    from Helix or the page go as Review Editor's compiled prompt with
    "Review of <title>." on top (compilePrompt, threads.send, markSent).
59. **No background cost in large repositories** (supersedes the git parts
    of 10, 39 and 56, and the 30 s fallback of 31): the turn-end changes list
    is built from the turn's own edits (the `fileChange` diffs, placed in
    the file's current text read once through Helix) and Helix's
    `event/reloaded` ranges, with no git at turn start or end (it used to run
    a status and a full diff at both). Turn snapshots for `:bb-review turn`
    only with `reviewTurnSnapshots` (off), timed, with a doctor note when one
    exceeds a second. An active review refreshes on a Helix save or reload
    there, bb's environment change, a turn's end, or the same target asked
    again; the 4 s timer is gone. The annotations' 30 s poll is gone (Review
    Editor notifies every write). What remains on timers reads no
    repository: the registry rescan (5 s) and the reconcile (30 s).

## Second pass: the rail (docs/HELIX_REVIEW.md, AUDIT.md)

60. **The rail lives in bb's sidebar** (navPanel `experimental_sidebar`), not
    in the page. At 1440 px with bb's sidebar and the chat open the page body
    is 560 px; a 260 px rail inside it left Helix 29 columns. In the sidebar
    the page is all Helix (56 columns with the chat open, 112 with it
    closed), and the rail gets bb's resize and collapse. Escape inside it is
    "back to Helix" (bb's own Escape is "Back to app"); a rail in bb's
    collapsed sidebar or closed drawer (compact windows keep it mounted and
    `inert`) draws nothing, and ⇧⌘H, ⇧⌘Y and `space e` open the same rail as
    a sheet over the editor. Only one rail is mounted at a time, so one yazi
    session never has two surfaces.
61. **The chat closes on the first visit when Helix would get fewer than 80
    columns** with it open, decided once Helix has drawn (its real column
    count). From then on the panel's state is the owner's, remembered per
    window class (narrow < 1100 px, medium < 1700 px, wide). No API sets the
    panel's width, so closing it is the only lever.
62. **"Comments", not "Notes"**: Review Editor, `:bb-comment` and Send to
    thread already say comments; a second word for the same thing is what
    the audit marks as inconsistent.
63. **Opening the Changes tab starts the review** (`auto`: the branch when
    the current branch is not the default one, else uncommitted). There is
    nothing to confirm; the review dialog is gone, and the palette's "Helix:
    review changes" opens the page on Changes.
64. **The `turn` target and its setting are gone.** bb's viewed marks answer
    "what changed since I looked": a mark holds a file's revision, so a file
    the agent touches comes back unviewed by itself, with no snapshot and no
    git per turn. The host's git shrinks to revision, subject and recent
    commits (the Commit scope, read when it opens).
65. **The rail reads the review the server already keeps** (the same
    bb--git files and diff Helix's review uses, refreshed on signals only),
    plus bb's viewed marks for it. Patches come from bb's `patches` by
    `[environment, target, ignoreWhitespace, path, revision]`, fetched when
    the cursor rests on a row for 140 ms and kept per revision, so holding
    `j` costs nothing and a file is fetched again only when it changes.
66. **bb's Git plugin lists at most 500 files.** Past that the rail says the
    list is cut short and suggests a narrower scope; Helix's review gets the
    same 500. Listing more would need our own git listing and our own
    revisions for viewed marks; not worth it for now. Past 300 files the
    folders start collapsed; the list is virtualised (28 px rows).
67. **The flyout lies over Helix**, right of the rail, full height of the
    editor: there is no room beside Helix at 1440 px with the chat open. On
    a page 1200 px or wider it takes 60% of the room (at most 760 px) so
    Helix stays visible; with less than 360 px beside the rail (the sheet on
    a compact window) it covers the page as a peek. It shows while the list
    has focus and leaves when focus does. Each change's line is a button
    that opens Helix there; a deleted file's diff is its old text, so Enter
    keeps the flyout instead of opening nothing.
68. **The rail's tabs are a quiet underlined row**, so the Changes tab's
    scope control (the segmented control) reads as the stronger choice
    beneath it; two stacked segmented controls read as equals.
69. **`j`/`k` stop on files** and on closed folders only, so skimming never
    lands on a folder header and drops the flyout. Files at the workspace
    root come first, without a folder row.
70. **The page header shows where Helix is** (file:line, diagnostics); the
    thread chip and the switcher to other editors moved to the top of the
    rail, the tree toggle to ⇧⌘Y and the rail itself.
71. **Palette "Helix: reload buffers changed on disk" is gone**: a Helix
    with `watch` reloads by itself; `bb hx reload` remains for the rare case.

## Second pass: comments

72. **The comment box replaces Helix's prompt only where bb draws Helix**:
    `commentPrompt` and `action` are subscribed (one kind per request, as
    `files`) only for an instance whose registry carries both
    `BB_THREAD_ID` and `BB_TERMINAL_SESSION_ID`. Elsewhere `:bb-comment`
    opens Helix's own prompt and `:bb-emit` says no client handles it.
73. **The box is placed from Helix's cells**: below the selection's last row
    when it fits, else above its first row, else resting on the pane's
    bottom edge; clamped inside Helix's pane, never over the rail (a rail
    sheet steps aside when the box opens). Cell size comes from the
    renderer (device pixels over the pixel ratio). Measured on the real
    build: 13-16 ms from Enter to the box (one frame).
74. **Lines from a Helix selection**: a selection that ends at column 1 of a
    line ends on the line before (what `x` selects), as `:bb-comment` does.
75. **The box keeps comments where `:bb-comment` does** (Review Editor when it
    runs and the file is in the workspace, else Helix Bridge's own list);
    the two paths share one function. ⌘Enter keeps the comment, then sends
    every comment not sent yet with the handoff.
76. **Comment states, as the owner sees them**: not sent (Review Editor's
    `open`), sent, answered (sent, the last reply is the agent's), resolved
    by the agent (until acknowledged), done (acknowledged, or resolved by
    the owner; hidden behind "N done"), outdated. The Comments tab's count is
    what needs the owner (answered plus resolved), else what waits to be
    sent.
77. **One verb, one result**: every send path says "Sent to <thread>"
    (Helix's status line, the bar's chip), and "Comment added: N not sent
    yet" replaces "N pending (:bb-comments-send)".
78. **The handoff lands where the work went**: the chat's composer when the
    chat is open, else the thread chip at the top of the rail (the chat is
    closed by default when Helix would be narrow). Reduced motion: no
    flight, the chip cross-fades.
79. **Dropping a comment takes `d` twice** in the Comments tab (the hint says
    so), not a dialog: dialogs are for destructive confirmation of bigger
    things, and an unsent comment is small.
80. **`:bb-emit` actions and the Option-Cmd keys are one table** (app/pages/
    pageActions.ts): the palette commands, the keys and Helix's bindings all
    call it, so an action has one name everywhere. `rail.notes` is accepted
    as `rail.comments` (the design's first name).

## Second pass: around the page and the settings

81. **The header button says what waits**: "9 to view" (with the Helix icon)
    while the thread's review has files not viewed, else "Helix"; it opens
    the page on Changes. Thread actions have no badge, and a bare number
    after "Helix" reads like a version. The context card gets one row,
    "Changes: 12 files, 9 to view, 3 comments need you". Both read
    `reviewSummaries`: the review the server holds, bb's viewed marks and
    the comment counts; no git. A thread with no active review shows
    neither (bb's own changed-files segment already says what changed).
82. **⌥⌘E opens the editor for the thread** (the audit asked for a key; ⌥⌘H
    is macOS's "Hide others").
83. **Settings, 21 to 10.** `autoReload` is gone (a Helix with `watch`
    reloads by itself; an older one is always asked to). The nine agent-tool
    switches are one list, `agentTools` (empty: no agent surface, as the
    owner wants). `reviewTurnSnapshots` went with the `turn` review. What
    remains: `hxbPath`, `followAgent`, `agentTools`, `treeStaysOpen`,
    `positionInMessages`, `hud`, `fontFamily`, `fontStyle`, `fontSize`,
    `bridgeDir`. Values saved for the removed settings are ignored.
84. **Not built: the sidebar mark** for threads with unviewed changes (the
    design's optional setting). The header count and the context card row
    cover the same need without adding a setting.

## Fluidity pass

85. **The editor surface outlives its page** (a pool in EditorSurface): the
    renderer, its key layer and the session stream stay attached for 10
    minutes after the page leaves, and the way back re-attaches the same
    element. Measured: a warm return shows Helix 3-19 ms after the page
    mounts (was 110-200 ms: stream attach and renderer). A session another
    surface shows gets its own surface; an ended session is never reused.
86. **The stream connects in parallel with the font and WebGL**, holding
    output until the renderer is ready. A fresh page load draws Helix's
    first frame 430-550 ms after the page mounts; what is left is bb's
    session lookup (30-90 ms) and the stream's attach and scrollback replay
    (about 300 ms), both bb's.
87. **Resizes reach Helix once, when they settle** (90 ms quiet): dragging a
    divider or the window resizes the surface every frame and Helix
    reflows one time (measured: 20 frames of drag, one resize sent). The
    page's editor owns its size unless another Helix surface has focus
    (focus is often in the rail now).
88. **`window.__helixTimeline`** records each step of opening (session,
    renderer, attached, firstOutput, firstFrame, reused) for
    `spike/open-timing.mjs`.

## Third pass: the owner's keys

89. **No default shortcuts in bb.** The owner did not want Option-Cmd or
    Shift-Cmd chords: every `defaultShortcut` is gone (this replaces the
    Cmd keys of 60 and of the second pass). Inside Helix everything is
    `space` and a key: `space e` for the files, `space u` and a letter for
    the rest (`space u` is free in Helix's own map), as bindings in the
    owner's config that run `:bb-emit <action>` or a `:bb-` command. The
    hints (`app/keys.ts`: the Send button, the `?` sheet) name those keys.
    The commands stay in the palette, and bb's Keyboard settings can bind
    any of them. "Open the editor" has no key: Helix is not running yet, so
    it cannot be a Helix key (the header button and the palette open it).
90. **The rail is a sheet, not bb's sidebar** (replaces 60). The owner
    expects the tree to close when a file is opened from it, and a plugin
    cannot collapse bb's sidebar, so a rail there could never go away. The
    `experimental_sidebar` registration is gone: bb's sidebar stays bb's,
    Helix has the whole page, and the rail (same three tabs) is the sheet
    over the editor's left edge that was the fallback for a collapsed
    sidebar. A key opens it with the keyboard; choosing a file, a change or
    a comment, Escape, or a click outside closes it. It unmounts when
    closed, so none of its keys act unseen; the yazi session stays and is
    attached again on the next open. Places that open the page for a review
    (the header's "N to view", the context card row, "Helix: review
    changes") open it with the rail showing, and the editor's opening
    focus leaves the keyboard there.
91. **Escape in the page's chat goes back to Helix**, after bb has had its
    own use of the key (it is ignored when bb prevented it or a menu or
    dialog is open). With `space u t` to get there, the chat needs no chord.
    In the rail, `C` sends the comments (the same letter as `space u C`).

