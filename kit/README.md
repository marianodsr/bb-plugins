# Shared design kit

## Changes

The exported API has not changed since the kit was first published. Current
kit: `36f976388355` (see `plugins/<id>/kit/VERSION`). If your copy differs, re-run
`node ../../kit/scripts/sync.mjs <id>`.

`36f976388355`:

- `Skeleton` is now one element, so width classes (`w-2/5`, `flex-1`) size
  the flex or grid item itself. Before, percentage widths resolved against a
  wrapper that collapsed to zero in a flex row, so `SkeletonRows` drew its
  title bars at zero width. Measured in the gallery in flex, grid and block
  parents at 1440 and 420 px. `kit-skeleton` now carries the 150 ms delay
  itself; `kit-skeleton-delay` still exists for custom wrappers.
- Handoff flight: the target is resolved two frames after the gather and
  followed while the packet is in the air, and the packet lands on the
  visible part of the target, clamped inside the viewport. Before, a composer
  that grew as the prompt was inserted could put the landing point below the
  viewport.

`ce58452db992` (fixes after the first copies):

- `HandoffSheet`: the new-thread dialog keeps `NewThreadComposer`'s props
  stable. Earlier copies crashed the host composer ("Composer stopped
  working", React error #185).
- Handoff flight: source items always return to full opacity after a failed
  or cancelled flight.
- Icons that do not exist in bb were replaced (`Send` to `ArrowUp`,
  `TextCursorInput` to `Edit`).
- `ThreadChip` is 28 px tall; chips, segments and picker rows get 44 px touch
  targets on coarse pointers.
- `InlineComposer` autofocus no longer scrolls the page.

The design layer shared by Review Editor, Task Board and Jira Viewer. It
implements [docs/DESIGN.md](../docs/DESIGN.md): host-token colour, the type
roles, the motion tokens with reduced-motion handling, and the handoff.

`/kit` is the source. Each plugin gets a generated copy in
`plugins/<id>/kit/`; set-up and update steps are in
[docs/CONVENTIONS.md](../docs/CONVENTIONS.md#the-shared-kit-how-a-plugin-consumes-it).
In short:

```sh
cd plugins/<id> && npm install motion && mkdir -p kit
node ../../kit/scripts/sync.mjs <id>        # re-run after every kit change
```

```tsx
import { useHandoff, HandoffSheet, SentChip, Tint, useHotkeys } from "./kit";
```

Every piece is live in the Kit Gallery page (`/plugins/kit-gallery/gallery`,
dev only).

The kit depends on the scaffold's vendored `components/ui/{button,dialog,icon}`,
`lib/utils`, `lib/portal-scope`, on `motion`, and on host-shimmed
`@radix-ui/react-popover`, `@radix-ui/react-slot` and `sonner`.

## Motion

### `ms`, `ease`, `spring`, `transitions`

The DESIGN.md tokens. `ms` is milliseconds (`press` 120, `enter` 200, `exit`
140, `handoff` 520, `reducedFade` 120, `loadingDelay` 150). `ease` holds
cubic-bezier arrays. `spring.shift` is 520/38/0.9, `spring.lift` 380/26/0.8,
`spring.handoff` 260/30. `transitions[token]` is a ready `motion` transition.

```tsx
<motion.div animate={{ x: 40 }} transition={transitions.shift} />
```

### `useKitMotion()`

Returns `{ reduced, transition(token), variants }` for the user's
`prefers-reduced-motion`. When reduced, every transition is a 120 ms linear
fade and the variants drop travel and scale. Use it instead of the raw tokens
in components.

```tsx
const { transition, variants } = useKitMotion();
<AnimatePresence initial={false}>
  {rows.map((r) => (
    <motion.li key={r.id} layout transition={transition("shift")}
      variants={variants.listItem} initial="hidden" animate="visible" exit="exit" />
  ))}
</AnimatePresence>
```

Pass `initial={false}` to `AnimatePresence` on lists: the first paint does not
animate (DESIGN: no stagger on load).

### `variants`, `reducedVariants`

`fadeScale` (popovers, toolbars, chips), `collapse` (grid rows; content in a
`min-h-0 overflow-hidden` child), `listItem` (insert and remove). Each has
`hidden`, `visible`, `exit`.

### `prefersReducedMotion()`

Non-hook check for imperative code.

### `kit.css`

Imported by `kit/index.ts`. Provides `--kit-dur-*` and `--kit-ease-*`
properties and these classes, all reduced-motion aware:

| Class | Use |
|---|---|
| `kit-live-pulse` | ring pulse on a dot (uses `currentColor`) for live status |
| `kit-live-line` | slow opacity breathe, e.g. the live line on a running card's edge |
| `kit-skeleton`, `kit-skeleton-delay` | skeleton fill, and the 150 ms invisible delay |
| `kit-progress-bar` | the indeterminate 2 px refresh bar |
| `kit-flash` | a row that changed flashes its background once |
| `kit-collapse` | grid-rows collapse (used by `Collapse`) |

```tsx
<span aria-hidden className="kit-live-line absolute inset-y-1 left-0 w-0.5 rounded-full bg-success" />
<tr key={`${issue.key}:${issue.updated}`} className={changed ? "kit-flash" : undefined} />
```

## Hooks

### `useHotkeys(hotkeys, { scope?, enabled? })`

Keyboard shortcuts that ignore typing in inputs and editors (Escape is
allowed by default). Combos: `"j"`, `"?"`, `"shift+n"`, `"mod+k"` (Cmd on
macOS, Ctrl elsewhere), `"Escape"`, `"ArrowDown"`, `"["`; an array binds
several. With `scope`, keys fire only while focus is inside that element or
nothing is focused. Bindings with a `description` appear in `ShortcutSheet`.

```tsx
const page = useRef<HTMLDivElement>(null);
useHotkeys([
  { key: ["j", "ArrowDown"], handler: next, description: "Next issue", group: "Navigation" },
  { key: ["k", "ArrowUp"], handler: prev, description: "Previous issue", group: "Navigation" },
  { key: "/", handler: () => search.current?.focus(), description: "Search" },
  { key: "t", handler: () => handoff.setOpen(true), description: "Send to thread" },
], { scope: page });
```

Also exported: `formatCombo(combo)` (display parts), `isTypingTarget(target)`,
`useRegisteredHotkeys()`.

### `useContainerWidth<T>()`

`{ ref, width }` from a ResizeObserver, measured before paint. Use it when the
structure changes with the container (margin rail versus folded comments);
use Tailwind `@container` classes for styling-only changes.

```tsx
const { ref, width } = useContainerWidth<HTMLDivElement>();
return <div ref={ref}>{width >= 880 ? <MarginRail /> : <FoldedComments />}</div>;
```

## Components

### `Kbd`, `ShortcutHint`, `shortcutLabel`

`Kbd` is one key cap. `ShortcutHint` renders a combo (`mod+enter` becomes
`⌘ Enter`) with optional trailing text. `shortcutLabel(combo)` is the plain
string for `title` attributes.

```tsx
<Button title={`Comment (${shortcutLabel("c")})`}>Comment <Kbd>C</Kbd></Button>
<ShortcutHint combo="mod+Enter" label="to send" />
```

### `ShortcutSheet`

The `?` sheet: every described `useHotkeys` binding on the page, grouped.
Renders a small `?` button (or pass `trigger={false}` and rely on the key).
Place it once per page, in the header.

```tsx
<header className="flex items-center gap-2">... <ShortcutSheet /></header>
```

### `Segmented`

Segmented control with a sliding thumb; arrow keys move the selection;
`role="radiogroup"`.

```tsx
<Segmented aria-label="View" value={view} onChange={setView}
  options={[{ value: "edit", label: "Edit", title: "Edit (E)" }, { value: "diff", label: "Diff", title: "Diff (D)" }]} />
```

### `StatusDot`, `threadRunStatus`, `runStatusLabel`

Four states: `idle` (hollow ring), `running` (green, pulsing), `waiting`
(amber, "Needs you"), `failed` (red). Shape and colour both carry the state.
`threadRunStatus(thread)` maps a bb sidebar thread onto them.

```tsx
<StatusDot status="running" />
<StatusDot status={threadRunStatus(thread)} label={thread.indicatorLabel ?? undefined} />
```

### `ThreadChip`, `useLiveThread`

A thread's title and live status; click opens the thread
(`navigate.toThread`). Reads bb's live sidebar view; `title`, `status` and
`prefix` override it. `useLiveThread(id)` returns the live thread or null.

```tsx
<ThreadChip threadId={comment.sentThreadId} />
<ThreadChip threadId={id} prefix="Sent to" />
```

### `Collapse`

Shows or hides content by animating grid rows; closed content is `inert`.

```tsx
<Collapse open={expanded}><Replies /></Collapse>
```

### `Skeleton`, `SkeletonRows`, `ProgressLine`

`Skeleton` is a block sized like the content it replaces; nothing shows for
the first 150 ms. `SkeletonRows` is a list placeholder at 32 px (or 28 px
`dense`). `ProgressLine` is the 2 px background-refresh line; put it inside a
`relative` header. It appears after 150 ms.

```tsx
{isLoading ? <SkeletonRows count={6} /> : <IssueList />}
<header className="relative h-10 ..."><ProgressLine active={isFetching && !isLoading} /></header>
```

### `EmptyState`

What this is and the one action to take. `tone="error"` for failures: say
what failed and how to fix it.

```tsx
<EmptyState icon="MessageSquare" title="No comments yet"
  description={<>Select lines and press <Kbd>C</Kbd> to comment.</>}
  action={<Button size="sm" onClick={comment}>Comment</Button>} />
<EmptyState tone="error" icon="AlertCircle" title="Jira rejected the API token"
  description="Create a new token in Atlassian account settings and paste it in Settings."
  action={<Button size="sm" variant="outline" onClick={openSettings}>Open settings</Button>} />
```

### `Tint`, `hueFor`, `TINT_HUES`, `LABEL_HUES`, `TINT_CLASSES`

Categorical hue chips from Tailwind's palette at 15% with same-hue text,
switched by bb's `.dark` class (not the OS). Only for categories (labels,
status categories, severity); state and chrome use host tokens.
`hueFor(text)` gives a stable hue from `LABEL_HUES`. `TINT_CLASSES[hue]` is
the raw class string for custom elements.

```tsx
<Tint hue="red">Issue</Tint>
{task.labels.map((l) => <Tint key={l} hue={hueFor(l)} dot>{l}</Tint>)}
```

### `InlineComposer`

Create or edit in place. Enter submits, Escape cancels, `multiline` makes
Shift+Enter a new line, `keepOpen` clears and stays focused for the next one.
Optimistic: the field clears at once; if `onSubmit` rejects, the text returns
with the error under it.

```tsx
<InlineComposer placeholder="Task title" submitLabel="Add task" keepOpen
  onSubmit={(title) => createTask({ laneId, title })} onCancel={() => setComposing(false)} />
```

## Handoff

The signature act: send what the user is looking at to a thread. The caller
supplies items, the DOM elements to lift, a prompt builder and metadata; the
kit owns the target picker, the prompt preview, the motion, the new-thread
dialog, the toast and the "Sent to <thread>" result.

### `useHandoff(options)`

| Option | |
|---|---|
| `items` | the selection; empty disables the button |
| `getKey(item)` | stable key per item |
| `buildPrompt(items, target)` | the prompt text; also shown in the preview |
| `pluginMetadata?(items, target)` | stored on the receiving thread (`updatePluginMetadata`, or at spawn) |
| `noun?` | `{ one: "comment", many: "comments" }` for "Send 3 comments" |
| `currentThreadId?` | the thread this surface belongs to; enables "This thread" (insert into its composer, or send now) |
| `projectId?` | seeds the new thread's project and ranks this project's threads first |
| `newThreadTitle?(items)` | title for a created thread |
| `onSent?(result, items)` | after the thread has the work; persist "sent" state here |
| `hotkey?` | opens the sheet, shown on the button, e.g. `"s"` or `"t"` |

Returns a `Handoff`: `itemRef(key)` (ref callback for each item's element),
`open`/`setOpen`, `send(target)`, `startNewThread()`, `lastResult`, `phase`
(`idle`, `sending`, `sent`, `failed`), `error`, `label`, `count`,
`clearResult()`.

`HandoffResult` is `{ target, delivery, threadId, threadTitle, itemKeys,
prompt, at }`; `delivery` is `inserted`, `sent`, `queued` or `created`.

What happens per target:

- This thread, insert: sets metadata, then `composer.insert(prompt)` on that
  thread's on-screen composer (`useComposers`), and focuses it. Offered only
  when that composer is on screen (a thread page or a thread side-panel tab).
- This thread, send now / another thread: `updatePluginMetadata`, then
  `threads.send` with `mode: "queue-if-active"` (queues behind a running turn).
- New thread: bb's `NewThreadComposer` in a dialog, prompt seeded; on submit
  `threads.spawn({ ...request, pluginMetadata, title })`.

Toasts say "Sent to <title>", "Added to the composer of <title>", or "Not
sent: <reason>". A failure flies the packet back to the Send control.

### `HandoffSheet`

The Send to thread button (the packet's origin) and its sheet: search, this
thread, other threads with live status, New thread (`⌘Enter`), and a prompt
preview (`Tab`). Arrow keys and Enter drive it. Pass `children` for your own
trigger, `buttonLabel` to rename it ("Start work" on Task Board).

### `SentChip`

"Sent to <thread>" (or "Drafted in" for an insert), a `ThreadChip` that fades
in where the handoff started; under reduced motion it only cross-fades.

```tsx
const handoff = useHandoff({
  items: selectedComments,
  getKey: (c) => c.id,
  buildPrompt: (cs) => compilePrompt(cs),
  pluginMetadata: (cs) => ({ reviewCommentIds: cs.map((c) => c.id) }),
  noun: { one: "comment", many: "comments" },
  currentThreadId: threadId,
  projectId,
  hotkey: "s",
  onSent: (result, cs) => rpc.call("markSent", { ids: cs.map((c) => c.id), threadId: result.threadId }),
});

{comments.map((c) => <CommentCard key={c.id} ref={handoff.itemRef(c.id)} comment={c} />)}
<footer className="flex items-center gap-2">
  <span className="text-xs text-muted-foreground tabular-nums">{handoff.label} open</span>
  <SentChip result={handoff.lastResult} />
  <span className="flex-1" />
  <HandoffSheet handoff={handoff} />
</footer>
```

The motion: the selected items lift and fly into the Send control while a
packet forms there (about 240 ms), the packet springs to the target (the
thread's composer, its sidebar row, or the new-thread dialog) on a slight arc,
lands with a brief ring, and the items settle back (about 520 ms in all). It
runs on a fixed overlay with `pointer-events: none`, so it never blocks input,
and a new handoff cancels the previous one. With reduced motion nothing
travels; the chip cross-fades.

`transport` and `threads` options exist for demos and tests (the gallery
uses them); leave them unset in plugins.
