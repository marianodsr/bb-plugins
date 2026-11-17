# Helix Bridge audit, before the second pass

Driven for real on 2026-11-17 against `try/hxb` (`12d57f557`, twelve
capabilities) in a scratch Go repository (branch `feature`, 1 commit ahead
of `main`, two uncommitted files), with a real Claude Code turn in a test
thread, a held headless page at 1440 x 900 (dark), bb's sidebar and the
page's Chat tab open, the HUD on to read Helix's screen. Captures are in
`docs/screenshots/helix-bridge/audit-*.png`.

Counting rules: a **step** is one decision or action the user makes (a typed
command, a key chord, a click, writing a comment). **Keys** are keystrokes
including Enter, excluding the text of a comment. Moving to a line counts 3
(`15G`-style). A click is a step with 0 keys.

## The space the page has

At 1440 px with bb's sidebar (320 px) and the chat (560 px) open, the editor
page body is **560 px**. Today the tree takes 260 px of it, which leaves
Helix **296 px, about 29 columns**; with the tree hidden Helix gets 56
columns. Anything new beside Helix (a rail, a diff flyout) must not take
width from it on this layout, or Helix becomes unusable. This decides the
shape of the rail and the flyout in step 2.

Typing baseline (HUD, 120 keys, WebGL, DPR 1): **key to paint 10.6 ms p50,
16.2 ms p95**; redraw 0.6 ms p50. Any regression after this pass is a bug.

## The five flows today

| Flow | Steps | Keys | What it takes | What hurts |
|---|---:|---:|---|---|
| 1. Review what the agent just changed (2 places, 2 files) | 4 | 29 | (click into Helix) `:bb-next⏎` x2, `:bb-diff⏎` to see removed lines | No overview: a status line ("Agent changed 2 places in 2 files (:bb-next)") is all there is. Sizes per file, the files themselves and what is left are invisible. The inline diff is against `HEAD`, so the agent's edits and the user's own uncommitted edits look the same. A full review is `:bb-review uncommitted⏎` (23 keys) and then `:bb-review⏎` (11) for the picker. |
| 2. Comment on three places and send | 13 | 69 | per place: move (3), `x`, `:bb-comment⏎` (12), the text, `⏎`; then `:bb-comments-send⏎` (18) | A one-line prompt at the bottom of a 29-column Helix; no multi-line, no voice. Pending comments show only inline in the file you are in; there is no list, no edit, no drop. The status hint "(:bb-comments-send)" is cut off at this width. Sending has no button. |
| 3. Re-review after the agent's fixes | 9+ | 20 | `:bb-next⏎` x2; replies are drawn under each comment in Helix; acknowledging a resolved one needs Review Editor: leave for the thread page, open the panel (⌘J), the Review tab, find each comment, Acknowledge (x3) | Helix says "Resolved by the agent; acknowledge it in Review Editor to clear it": a dead end that sends you to another page. Nothing says which files changed since you looked: the inline diff still shows everything against `HEAD`. |
| 4. Open a file from the tree | 4 | 6 | `space e` (owner's binding), `l` `l` into folders, `j`, `⏎`; the tree closes and Helix has focus | Works and is quick. It needs the owner's own binding: on a fresh config the tree has no key in Helix (⇧⌘Y in bb). |
| 5. Get back to the chat | 1 | 0 | a click in the composer | No key: bb's own **Focus composer (⇧⌘C) does nothing on the editor page**, from Helix or from anywhere else on it. Back to Helix: a click (⇧⌘H only switches tree and editor). |

Total for one ordinary review loop (flows 1, 2, 3 and back to the chat):
**27 steps, 118 keys**, two page changes, and comment text typed into a
one-line prompt.

## What the plugin has today

### Settings (21)

| Setting | Verdict |
|---|---|
| `hxbPath` Editor binary | keep (needed until the fork ships on PATH) |
| `autoReload` Reload buffers when files change | **delete**: a Helix with `watch` reloads by itself; the plugin's reload remains only for older builds, always on |
| `followAgent` Follow the agent | keep; also offered as a toggle on the page |
| `toolShow`, `toolTour`, `toolSelection`, `toolQuery`, `toolDiagnostics`, `toolReview`, `toolEdit`, `toolPanes`, `toolCommand` | **fold** nine checkboxes into one list setting, `agentTools` (empty by default): the owner's rule is no agent surface, and nine switches for a surface that is off reads as the opposite |
| `reviewTurnSnapshots` Review the last agent turn | **delete** with the `turn` target: viewed marks answer "what changed since I looked" with no snapshot and no git per turn |
| `treeStaysOpen` Keep the file tree open | keep (the owner asked for it); the label moves to the rail's own terms |
| `positionInMessages` Attach the editor position to every message | keep |
| `hud` Performance and key HUD | keep, labelled as a diagnostic |
| `fontFamily`, `fontStyle`, `fontSize` | keep (overrides of Ghostty's) |
| `bridgeDir` Bridge directory | keep (rare) |

### Palette commands (6) and shortcuts (2)

| Command | Key | Verdict |
|---|---|---|
| Helix: open the editor for this thread | none | keep; add a key |
| Helix: reload buffers changed on disk | none | **delete** (`watch` does it; `bb hx reload` stays for the rare case) |
| Helix: switch focus between the file tree and the editor | ⇧⌘H | keep the key, widen the meaning: rail and editor |
| Helix: show or hide the file tree | ⇧⌘Y | keep the key: show or hide the rail |
| Helix: review changes in the editor | none | keep the name, new behaviour: opens the Changes tab (the dialog goes) |
| Helix: bind this thread to a running Helix | none | keep (rare) |

bb's own Cmd bindings (from its Keyboard settings) that the new keys must
avoid: ⌘N ⌘K ⌘P ⌘F ⌘O ⌘L ⌘R ⌘D ⌘T ⌘W ⌘J ⌘, ⌘\ ⌘[ ⌘] ⌘1-9 ⌘. ⌘↩, ⇧⌘O ⇧⌘N
⇧⌘P ⇧⌘[ ⇧⌘] ⇧⌘T ⇧⌘E ⇧⌘X ⇧⌘C ⇧⌘M ⇧⌘↩, ⌃⌘ and ⌃⇧⌘ arrows, ⌥M ⌥P ⌥T.

### Helix commands (15)

`:bb-send` `:bb-send!` `:bb-ask` `:bb-comment` `:bb-comments-send`
`:bb-review` `:bb-next` `:bb-prev` `:bb-locations` `:bb-go` `:bb-diff`
`:bb-files` `:bb-annotations` `:bb-status` `:bb-emit` (new). None has a
default key: every one is typed unless the owner binds it.

### CLI (16)

`bb hx list state open tour review reload selection diagnostics query panes
command bind unbind perf-mode doctor tree-open`. Agent-facing by design;
`tree-open` is internal (the tree's opener).

### Surfaces in bb (9)

Editor page (header: tree toggle, thread chip, Review control, position,
diagnostics, thread switcher), its Chat tab, the review dialog, the thread
header action "Helix", the thread tab "Helix" (quick look), the thread
context card row, the thread context segment, the composer's position
action and chips, the app overlay ("The agent is showing you a place").

## Marks

Confusing

- Review targets are words to remember (`uncommitted`, `branch`, `pr`,
  `turn`, `commit <sha>`); `commit` must be quoted because Helix takes one
  argument.
- A review's "what is left" and "what did I look at" exist nowhere.
- "Resolved by the agent; acknowledge it in Review Editor to clear it" asks
  for a trip to another page.
- A deferred follow jump ("bb wants to show main.go:15 (:bb-go)") stays on
  the status line after the turn ended and after the user moved elsewhere.
- Status-line hints in parentheses are cut off at the widths the page
  actually has ("(:b").

Redundant

- Two ways to start a review that do the same thing (`:bb-review <target>`,
  the dialog), a third from Review Editor ("Open in Helix"), a fourth in the
  CLI; none shows the files.
- Two lists of the agent's changes: the "changes" locations list after each
  turn and a `turn` review.
- `autoReload` and the reload command, now that Helix watches files.
- The thread tab "Helix" (quick look) and the editor page: two places to see
  the same editor.

Inconsistent with DESIGN.md

- The primary action, sending comments, has no button, no key hint and no
  handoff; DESIGN.md: "every primary action has a key, shown as a hint", the
  verb is **Send to thread**, the toast **Sent to <thread>**. Today: "Sent 3
  comments to …", "Sent the comments to …", "Sent to …" for three paths.
- "Comment added: 3 pending for … (:bb-comments-send)": pending is not a
  word the UI uses elsewhere; Review Editor says open, sent, resolved.
- Errors start with "bb: " in some paths and not in others.
- The review dialog is a modal for a non-destructive choice (DESIGN.md:
  dialogs are for the new-thread composer and destructive confirmation).
- No `?` sheet on the page.
- The header packs six controls into a 560 px page header; the tree icon
  overlaps the page title at this width.
- Focus after the dialog closes is lost (keys go nowhere until a click).

## What carries over

Follow and watch (Helix reloads by itself, the view moves, an unopened file
opens at the edit), the inline diff, inline comment and reply annotations,
the tree's open-and-close, and the no-git-per-turn rule all work and stay.
The second pass changes how review is started, seen, written and sent.

## After the second pass

Driven again on `try/hxb` `140fc91af` (the fork's `commentRequest` and
`:bb-emit`), same repository, same 1440 x 900 window. On a first visit the
chat closes because Helix would get fewer than 80 columns with it open; ⌥⌘C
brings it back. Counting rules as above; an Option-Cmd chord is one key.

| Flow | Before (steps / keys) | After (steps / keys) | What it takes now |
|---|---:|---:|---|
| 1. Review what the agent just changed | 4 / 29 | 2 / 2 | ⌥⌘2 (Changes: the review starts itself, the list shows every changed file with its size and what is viewed, the flyout shows the first diff), `j` for the next. `u` (one more key) leaves only what changed since you looked. |
| 2. Comment on three places and send | 13 / 69 | 13 / 52 with Helix's keys as they are; 10 / 19 with `C = ":bb-comment"` bound | per place: ⌥⌘] to the next changed file (or move), `x`, `:bb-comment` (or `C`), the comment in a multi-line box, Enter; then ⌥⌘↩. The comments are listed, editable and droppable before they go. |
| 3. Re-review after the agent's fixes | 9+ / 20, two page changes | 8 / 8, no page change | ⌥⌘2, `u` (the files the agent touched come back unviewed by themselves), `j` per file, ⌥⌘3 (answered and resolved comments first), `a` per resolution. |
| 4. Open a file from the tree | 4 / 6 | 4 / 6 | `space e` (or ⌥⌘1, ⇧⌘Y), move, Enter: unchanged, and the tree now has the sidebar's full height. |
| 5. Get back to the chat | 1 click, no key | 1 / 1 | ⌥⌘C (opens the chat if closed and focuses its composer); ⇧⌘H goes back to Helix. |

One ordinary review loop (flows 1, 2, 3 and back to the chat): **before 27
steps and 118 keys with two page changes; after 24 steps and 63 keys, or 21
steps and 30 keys with one Helix binding, and no page change.**

What the keys do not show: Helix has 112 columns instead of 29 at this
window size; the review is visible all the time (rail, bar, header count);
comments are written in a real box and sent with the handoff; a resolved
comment is acknowledged where it is shown.

Measured (headless Chrome, software WebGL; a GPU makes drawing faster):

| Interaction | Time |
|---|---|
| Back to the editor (warm) | Helix drawn 3-19 ms after the page mounts (was 110-200 ms) |
| Fresh page load | first frame 430-550 ms after mount (bb's session lookup and stream replay) |
| Comment box after `:bb-comment` Enter | 13-16 ms |
| Rail tabs (⌥⌘1/2/3) | Changes 2-12 ms, Comments 6-9 ms, Files 3-9 ms after its first visit (first visit 260 ms: yazi starts) |
| ⇧⌘H, ⌥⌘C | focus moves in about 1 ms |
| Enter on a changed file | Helix has the keyboard in 7 ms; the file is drawn 230-500 ms later (server work 2-9 ms; the rest is drawing in software GL) |
| Viewed mark (`v`) | the count changes in under 150 ms, before the server answers |
| Scope switch with 3,003 changed files | 400 ms, the control answers at once |
| Dragging a divider | 20 frames of drag, one resize sent to Helix |
| Typing in Helix (HUD, 50-120 keys) | key to paint 9.7-13.5 ms p50, 15-19 ms p95 (audit baseline 10.6 / 16.2) |

Not verified live: the context card's Changes row (implemented and
typechecked; I could not open bb's context card environment rows in the
headless page), a repository that is not git (the Changes tab shows bb's Git
plugin's reason), a full disk, and a Helix crash on this build (the classifier
refused killing the process; the crash report path is unchanged and was
verified on the previous build).
