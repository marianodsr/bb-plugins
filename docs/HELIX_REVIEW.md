# Review in Helix Bridge, second pass

The owner's verdict on the first version: reviewing changes works but is
clunky, and it leans on the terminal for everything. This pass makes review a
native bb experience wrapped around Helix. Helix stays the place where code
is read and edited; everything around it (what changed, where you are in the
review, your comments, sending them) becomes bb UI built with the kit and
`docs/DESIGN.md`.

The owner's standing rules still bind (see the memory note "editor is for
the user"): nothing for the agent's context, no background git, no timers
that touch the repository, nothing that slows typing.

## What is clunky today

| Today | Why it hurts |
|---|---|
| A review starts by typing `:bb-review branch`, or by opening a dialog | You must remember target words; the dialog is a detour that closes again |
| The changed files exist only in a Helix picker | No standing overview: you cannot see how much is left or what you already looked at |
| A comment is one line in Helix's prompt | No room to think, no multi-line, no voice, no sight of the code while typing |
| Pending comments are invisible until sent | You cannot scan, fix or drop one before it goes |
| Sending is another typed command | The most important action has no button and no feedback |
| After the agent answers, you start over | Nothing says which files changed since you looked |
| Review, the file tree and the chat are three unrelated things | Each has its own way in and out |

## The idea: a review deck around the editor

The editor page gets one native rail on the left with three tabs, and a quiet
bar above the editor. Review stops being a command and becomes a state of the
page: open the Changes tab and you are reviewing.

```
+------------------------------------------------------------------------+
| feature <- main   12 files  +340 -85   PR #42 checks ok     Diff  on   |
|                                          3 comments   Send to thread S |
+----------------------+-------------------------------------+-----------+
| Tree  Changes  Notes |                                     |           |
|----------------------|                                     |  chat     |
| Uncommitted | Branch |           Helix                     |  (bb's    |
|  3 of 12 viewed      |   (inline diff, your keys,          |  own)     |
|                      |    comments drawn in the code)      |           |
| services/auth        |                                     |           |
|  M session.go  +12-4 |                                     |           |
|  M token.go   +40-9 2|                                     |           |
|  A refresh.go +88    |                                     |           |
| api                  |                                     |           |
|  D legacy.go     -31 |                                     |           |
+----------------------+-------------------------------------+-----------+
```

### Changes tab

- **Scope** is a segmented control with a sliding thumb: Uncommitted, Branch,
  PR (only when the thread has one), Commit. It remembers the last choice
  per thread and picks a sensible first one (Branch when the branch is ahead
  of its base, else Uncommitted). Choosing a scope starts the review in
  Helix at once; there is nothing to confirm.
- **Files** as a compact tree grouped by folder: status, name, `+n -m` in
  tabular figures, a count of open comments, and a viewed mark. Rows flash
  once when the agent has just changed that file.
- **Viewed** uses bb's own viewed marks from the bundled Git plugin
  (`viewed`, `markViewed`, `clearViewed`), which bb's diff panel shares. A
  file stops counting as viewed when its content changes, so after the agent
  answers your comments the files it touched come back unviewed by
  themselves. "Unviewed only" is a filter. This is how "what changed since I
  looked" works, with no snapshots.
- **Skim without leaving the list.** Moving through rows shows that file's
  diff in a flyout beside the rail using bb's own diff component
  (`experimental_Diff`), so the whole change can be skimmed with `j`/`k`.
  Enter opens the file in Helix at its first change and gives Helix focus.
  Each change in the flyout can be clicked to land on it in Helix.
- **Progress**: "3 of 12 viewed" with a thin bar. When everything is viewed
  the bar's place becomes the send action.
- **Keys in the rail**: `j`/`k` move, Enter opens in Helix, `v` marks
  viewed and moves on, `u` toggles unviewed only, `c` comments on the file
  as a whole, Escape returns to Helix. `?` lists them.

### Notes tab (your comments)

- Every comment of this thread's review, grouped by file: the quoted lines,
  the comment, and its state (not sent, sent, answered, resolved by the
  agent and waiting for you). Agent replies sit under their comment.
- Click or Enter jumps Helix to the lines. A comment can be edited, dropped,
  answered, reopened or acknowledged in place.
- The tab title carries the count of what needs you.

### Writing a comment

In Helix you select lines and press your comment key, exactly as now. Inside
bb, instead of Helix's one-line prompt, a native composer opens over the
editor, anchored to the selection: the quoted lines, a multi-line field with
voice input, the severity as chips, Enter to keep it, Cmd+Enter to send it
now, Escape to cancel. Focus returns to Helix on close, in the mode you were
in. Outside bb, Helix's own prompt remains.

### The review bar

- What is being reviewed, in words: "feature against main", "uncommitted
  changes", "commit 55143f2: fix the token refresh".
- Size: files, added, removed. The thread's pull request when it has one
  (number, check state from bb's GitHub plugin, link).
- **Diff** toggle for the inline diff.
- **Send to thread** with the count of comments not yet sent, the same verb
  and the same handoff animation as everywhere else in these plugins: the
  comments gather and fly to the chat beside the editor. The message the
  agent gets names the review.

### Tree tab

The yazi tree, unchanged: `space e` still opens it and Enter still closes
it. It is simply the first tab of the same rail, so the three ways of
getting to a file live in one place and one key switches between them.

### Around the page

- **Thread header**: the Helix button gains a small count when the thread
  has changes you have not viewed; it opens the page on the Changes tab.
- **Thread context card**: one row, "Changes: 12 files, 9 to view, 3
  notes", that opens the same place.
- **Sidebar**: optionally a small mark on threads with unviewed changes
  (setting, default off; it reads only the git status bb already keeps).
- **Palette**: "Helix: review changes", "Helix: send review comments",
  "Helix: next changed file", "Helix: previous changed file".

## Keys

Cmd belongs to bb, so review actions that must work from inside Helix are on
Cmd and work in any Helix mode: next and previous changed file, mark viewed,
focus the rail, send comments. Check each against bb's own bindings and
choose free ones; show them in the shortcut sheet.

For people who would rather stay in Helix's own keys, the fork gains one
generic command, `:bb-emit <action>`, that hands an action name to the
plugin (`review.next-file`, `review.prev-file`, `review.viewed`,
`review.send`, `rail.changes`, `rail.notes`, `chat.focus`). They bind it
like any other command; the README lists the actions.

## What the fork adds (small)

1. `:bb-emit <action> [words]` and `event/action`.
2. `:bb-comment` with no text, when a client asks for it (a new subscription
   kind), emits `event/commentRequest` with the selection and where it is on
   screen (row and column of the selection's first and last cells in the
   terminal grid) instead of opening Helix's prompt. Without that subscriber
   the prompt stays.
3. Nothing else. The review itself (base, inline diff, picker) is already
   there and the native list drives it through `review/set`.

## Rules for building it

- **No agent surface.** No tool, no instruction, no skill text for any of
  this.
- **No git of our own on a timer.** The rail reads bb's Git plugin (changed
  files, patches for the flyout, viewed marks, the status bb already keeps
  current) and only while the page is on screen. A flyout diff is fetched
  when its row is selected, with a short delay so holding `j` does not fetch
  every file, and cached until the file changes.
- **Large reviews.** A branch with thousands of changed files must stay
  smooth: virtualised list, folders collapsed past a size, patches fetched
  one at a time.
- **Typing in Helix is never slower.** The rail must not re-render on
  cursor moves; nothing in it subscribes to selection events.
- **DESIGN.md is binding**: host tokens, the type roles, the motion grammar,
  sentence case, every primary action on a key with a visible hint, empty and
  error states that say what to do. The handoff is the one orchestrated
  moment; the rest stays quiet.
- **Narrow widths.** At 420 px the rail becomes a sheet over the editor.

## Order of work

1. An audit first, written down: drive today's flows for real and count
   steps and keystrokes for "review what the agent just changed", "comment
   on three places and send", "re-review after the agent's fixes", "open a
   file from the tree", "get back to the chat". Also list every setting,
   command, shortcut and status text the plugin has, and mark what is
   confusing, redundant or inconsistent with DESIGN.md.
2. The rail with the Changes tab, the review bar, viewed marks and the
   flyout. The dialog goes away.
3. The Notes tab and the native comment composer (needs the fork's
   `event/commentRequest`).
4. Around the page: header count, context card row, palette, Cmd keys,
   `:bb-emit` actions.
5. The same step counts again, side by side with step 1.

## Later, if the owner wants it

A list of pull requests waiting for their review, each opening in its own
worktree thread with the review already started. It needs a look at what
bb's GitHub plugin offers and what `gh` would cost; report before building.
