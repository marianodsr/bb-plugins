# Design language

One language for three plugins: Review Editor, Task Board, Jira Viewer. They
live inside bb, so they must read as part of bb in any theme the user picks,
and still be recognisably a family.

## Subject and audience

A developer who runs several agents at once. They read code and tickets, decide
what should happen, and hand that decision to an agent. The interface's job is
to make reading fast and handing off effortless. Everything here is a tool used
many times a day, so speed and calm beat spectacle.

## The one bold thing: the handoff

Every plugin ends in the same act: take what you are looking at (comments, a
task, an issue) and send it to a thread. That act gets the one orchestrated
piece of motion in the suite, and it is the same in all three plugins:

1. The selected items lift and gather into a single packet at the Send control.
2. The packet travels to the target (composer, thread chip, or new-thread sheet).
3. The source items settle back with a "Sent to <thread>" chip that links there.

Total about 520 ms, interruptible, and it shows something true: where the work
went. Same verb everywhere: the button says **Send to thread**, the toast says
**Sent to <thread title>**. With reduced motion the three steps become a
cross-fade of the status chip.

Everything else stays quiet so this lands.

## Colour

Host theme tokens only (`bg-background`, `bg-card`, `bg-muted`,
`text-foreground`, `text-muted-foreground`, `border-border`, `text-destructive`,
`ring-ring`, `bg-primary`, …). No custom `@theme` colours, no `oklch()` or hex
literals: they break user palettes. The brief's constraint replaces the usual
named-hex palette.

- Hierarchy comes from three surface steps (background, card, muted) and
  hairline borders at reduced opacity, not from shadows.
- Shadow means "lifted": only a dragged card, a floating toolbar, or the
  handoff packet has one.
- Categorical hue (task labels, Jira status categories, comment severity) uses
  Tailwind's default palette as a low-alpha tint with a same-hue text colour,
  for example `bg-amber-500/15 text-amber-700 dark:text-amber-300`. The kit
  gallery must prove these read in light and dark before anything relies on them.
- Diff colours come from the host's diff tokens or `experimental_Diff`; never
  invent red and green.

## Type

Host UI font and host code font; no bundled typefaces. Character comes from the
scale and its discipline.

| Role | Class | Notes |
|---|---|---|
| Document title (issue, task) | `text-xl font-semibold tracking-tight` | one per view |
| Section and card title | `text-sm font-medium` | |
| Body | `text-sm` at `leading-6` | prose capped at 72ch |
| Meta | `text-xs text-muted-foreground` | |
| Code | host code font, host size | |

- Numbers that change or align (counts, line numbers, issue keys, times) use
  `tabular-nums`.
- Sentence case everywhere. No all-caps labels, no eyebrow labels above
  headings, no meta strings joined with middle dots, no arrows appended to
  button text, no monospace for labels that are not code.
- Issue keys and file paths are content: keys in the UI font with tabular
  figures, paths in the code font.

## Shape and density

- Radii follow hierarchy: controls `rounded-md`, cards and rows `rounded-lg`,
  sheets and dialogs `rounded-xl`. Nested radii shrink by the padding between them.
- Spacing on a 4 px grid. Rows are 32 px in lists, 28 px in dense sidebars.
- Hit targets at least 28 px with a pointer, 44 px on compact viewports.
- Every page works in a 420 px side panel and in a full-width page; layouts
  switch on container width (`@container`), not on the window.

## Motion grammar

Motion answers an action and shows what changed. Nothing moves on its own
except live status (an agent running) and data arriving.

| Token | Value | Use |
|---|---|---|
| `press` | 120 ms, ease-out | hover, press, focus feedback |
| `enter` | 200 ms, `cubic-bezier(0.22, 1, 0.36, 1)` | popovers, toolbars, comment blocks appearing |
| `exit` | 140 ms, ease-in | the same things leaving; exits are faster than enters |
| `shift` | spring 520 / 38 / 0.9 (stiffness / damping / mass) | layout changes, list reorder, panels |
| `lift` | spring 380 / 26 / 0.8 | drag pick-up and drop |
| `handoff` | about 520 ms total, spring 260 / 30 | the signature only |

Rules:

- Animate `transform` and `opacity`. Size changes use FLIP (`motion`'s
  `layout`) or `grid-template-rows`, never animated `height` on large trees.
- Everything is interruptible. An animation never blocks input or delays an action.
- Shared-element continuity: when something opens from an element, it grows
  from that element and returns to it.
- Lists animate insert, remove and reorder. Initial page load does not
  stagger; content appears in place.
- Loading: nothing for the first 150 ms, then skeletons that match the final
  layout. Background refresh is a 2 px progress line under the header, never a
  spinner over content.
- Optimistic by default: the UI changes on the user's action and reconciles
  later. A failed write animates back and says why.
- `prefers-reduced-motion`: travel and scale are removed; opacity changes stay
  at 120 ms.

## Interaction principles

- Keyboard first. Every primary action has a key, shown as a hint beside the
  control and in tooltips. `?` opens the shortcut list on every page. `/`
  focuses search. `j`/`k` or arrows move through lists. `Escape` backs out one
  level.
- Focus is always visible (host ring token) and always restored after a sheet closes.
- Inline over modal: create and edit in place. Dialogs are for the new-thread
  composer (it needs width) and destructive confirmation only.
- Empty and error states give direction: what this is, the one action to take.
  Errors say what failed and how to fix it, without apology.
- Copy names things as the user sees them: "Send to thread", "Start work",
  "Mark resolved". An action keeps its name from button to toast.

## Layouts

### Review Editor

The comment lives beside the code it is about, like a note in a margin. Wide
containers get a margin rail; narrow ones fold comments into the gutter and
open them in place under the line.

```
wide (>= 880 px)                                narrow (side panel)
+--------------------------------+-----------+  +--------------------------+
| src/auth/session.ts  Edit Diff |           |  | session.ts    Edit Diff  |
+----+---------------------------+-----------+  +----+---------------------+
| 41 | const ttl = 60 * 60;      |           |  | 41 | const ttl = 60*60;  |
|*42 | if (!token) return null;  +- comment  |  |*42 | if (!token) return  |
| 43 | refresh(token);           |  on 42-43 |  |    | +- comment --------+|
| 44 |                           |           |  |    | | Why null here?   ||
+----+---------------------------+-----------+  |    | +------------------+|
| 3 open comments          Send to thread  S |  | 43 | refresh(token);     |
+--------------------------------------------+  +----+---------------------+
                                                | 3 open     Send to thread |
                                                +--------------------------+
```

- Selecting lines raises a small toolbar at the selection (Comment `C`).
- Change bars in the gutter mark added, changed and removed lines against
  `HEAD`; clicking a bar opens the old lines in place.
- Edit and Diff are one segmented control with a sliding thumb; switching
  keeps scroll position and the line under the cursor.
- The tray at the bottom is the origin of the handoff and is always present
  when comments are open.
- The Review tab (thread side panel) lists changed files with their counts and
  every comment grouped by file, each showing its state: open, sent, resolved.

### Task Board

Open lanes, not boxed columns. Cards are flat on `bg-card` with a hairline
border; they gain a shadow only while lifted. A card whose thread is running
carries a thin live line on its leading edge. When an agent moves its own
card, the card travels to the new lane by itself.

```
+--------------------------------------------------------------+
| Task Board   bb-plugins v     / Search     Board | List    N  |
+--------------------------------------------------------------+
| To do  4        In progress  2     Review  1      Done  12    |
|                                                               |
| +-----------+  |+----------+     +-----------+                |
| | Fix flaky |  || Editor   |     | Jira sync |                |
| | login     |  || comments |     | 1 thread  |                |
| +-----------+  |+----------+     +-----------+                |
| +-----------+   (live line: thread running)                   |
| | + New     |                                                 |
+--------------------------------------------------------------+
```

- `N` opens an inline composer at the top of the focused lane; Enter creates
  and keeps the composer open for the next one.
- Opening a card shows its detail in the page's side panel: the task as a
  document, its linked threads, and the linked thread's live chat beneath, so
  you can watch the agent from the board.
- Drag uses the `lift` spring; neighbours make room with `shift`. Keyboard:
  Space picks up, arrows move, Space drops, Escape cancels.
- List view is the same data as dense rows grouped by lane; switching views
  morphs each card into its row.

### Jira Viewer

A reading tool. The list is dense and scannable; the issue is a document, not
a form of boxed fields.

```
+----------------+---------------------------------------------+
| My open issues | / Search or JQL                      Refresh |
| Reported by me +---------------------------------------------+
| Recent         | In progress  3                               |
| ------------   | ENG-412  Session expires mid-upload   Ana    |
| Custom view    | ENG-398  Retry queue drops jobs       Leo    |
| + New view     | To do  7                                     |
|                | ENG-420  Export fails over 10k rows   --     |
+----------------+---------------------------------------------+

issue (side panel or split)
+---------------------------------------------+
| ENG-412                    Open in Jira     |
| Session expires mid-upload                  |
| In progress   Ana Ruiz   High   updated 2h  |
|                                             |
| Description as prose, 72ch measure ...      |
|                                             |
| Subtasks 2 of 5                             |
| Comments 4                                  |
|                         Send to thread   T  |
+---------------------------------------------+
```

- Saved views live in the page's sidebar (it replaces the thread list while
  the page is open).
- The list paints from a local cache at once, then refreshes behind the
  progress line. Rows that changed flash their background once.
- `j`/`k` moves, Enter opens, `T` sends the issue to a thread.

## Review against the brief

First pass was: GitHub-style inline comment boxes, shadowed rounded cards in
boxed kanban columns, a Jira table with a field form. That is what any tool
produces for this prompt, so it changed:

- Comments moved to a margin rail tied to their lines, folding into the gutter
  when narrow, because the subject is annotation, and annotation has a native form.
- Lanes lost their boxes and cards lost their resting shadows; shadow now
  carries one meaning (lifted) instead of decorating everything.
- The Jira issue became a document with a quiet metadata line, because the
  user's job there is reading.
- The boldness was pulled out of scattered hover and entrance effects and
  spent on the handoff, the one moment that is the same in all three and that
  is the reason these plugins exist.
