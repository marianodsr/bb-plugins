# Build and verification conventions

Facts proven by the kit thread on bb 0.49.0, plugin SDK 0.6.132, Tailwind
4.3, motion 14.14. Each fact says how it was proven.

Status: final for phase A. Everything below was proven on this machine except
where marked "not verified".

## Scaffold into `plugins/<id>/`

`bb plugin new <name>` always writes `./bb-plugin-<name>/`. The plugin id comes
from the package name, not the folder, so scaffold and rename:

```sh
cd /Users/marianodsr/projects/bb-plugins/plugins
bb plugin new review-editor          # creates ./bb-plugin-review-editor
mv bb-plugin-review-editor review-editor
```

`package.json` keeps `"name": "bb-plugin-review-editor"`, so the id stays
`review-editor`. Edit `bb.name`, `bb.description`, `bb.branding.icon`. Delete
the example `skills/example-todos/`, `README.md`, `PLUGIN_OVERVIEW.md` and the
todo code when you replace them.

## npm inside the agent sandbox

1. `bb plugin new` cannot reach the registry from a sandboxed command, so it
   skips `npm install` (it prints a warning; the scaffold is still complete).
2. The default npm cache `~/.npm` is not writable from the sandbox
   (`EACCES ... sudo chown`). Do not chown; point npm at a temp cache.

```sh
export npm_config_cache=$TMPDIR/npm-cache
npm install --include=dev            # allow registry.npmjs.org for the command
npm install motion                   # runtime deps go in dependencies
```

A `github.com` request is denied during install (a native prebuild probe); the
install still succeeds and builds work.

## Build, install, typecheck

```sh
npx tsc --noEmit                     # the scaffold's tsconfig covers server.ts and app.tsx
bb plugin build                      # under a second once the toolchain is cached
bb plugin install . --yes            # first time only; builds and registers the path
bb plugin reload <id>                # after each build, to load the new bundle
```

- Install from the plugin directory works in the sandbox and prints
  `<id>@0.1.0 running`. A path install builds from your `node_modules`.
- After `bb plugin build`, `bb plugin reload <id>` makes open pages pick up the
  new bundle (proven by rebuilding the gallery several times and re-shooting).
- Add `"kit"` (and any other source folder) to `tsconfig.json` `include`.
- `bb plugin dev` (watch, rebuild, reload) is the documented loop; build plus
  reload is what was used here and is enough.

How the CSS is produced (read from bb's build code, then confirmed by builds):

- Tailwind scans **only files inside the plugin directory** (`**/*`,
  excluding `dist/` and `node_modules/`). A file imported from outside the
  plugin (for example `../../kit/x.tsx`) is bundled into `app.js` but its
  classes are **not** generated. Proven with a probe class.
- Bare imports in a file outside the plugin directory (for example `motion`)
  fail to resolve, because esbuild resolves them from the file's own location.
  Proven by a failing build.
- Plain `.css` files imported from TypeScript are bundled by esbuild and
  appended to `dist/app.css` untouched (no Tailwind processing, no `@apply`).
  The kit ships its keyframes and custom properties this way.
- Utilities are scoped to your plugin root with
  `:where([data-bb-plugin=<id>], ...)`. Anything you portal or append to
  `document.body` must carry `usePortalScopeProps()` from
  `lib/portal-scope.ts`, or its utility classes do not apply.
- Theme values (`--text-sm` is 13 px, `--font-sans` is the host's Inter,
  `--font-mono` the host's mono stack) come from the host; the plugin build
  does not override them.

## Icons

`<Icon name>` (the vendored wrapper over `experimental_Icon`) silently draws
the Zap fallback for an unknown name. `Send`, `Inbox`, `CircleAlert`,
`TextCursorInput`, `TriangleAlert` do not exist. Names proven to exist include
`ArrowUp`, `AlertCircle`, `AlertTriangle`, `Check`, `ChevronRight`,
`ChevronDown`, `Code`, `Copy`, `Edit`, `Filter`, `Folder`, `Info`, `ListTodo`,
`MessageSquare`, `MessageSquarePlus`, `Palette`, `Plus`, `Search`,
`Settings`, `Target`, `Trash2`, `Workflow`, `Zap`. Check every icon in a
screenshot.

## The shared kit: how a plugin consumes it

The kit source is `/kit`. Plugins never import it from there (see the two
build facts above); a script copies it into `plugins/<id>/kit/` with a
`GENERATED` header on every file and a `kit/VERSION` hash.

One-time setup in your plugin:

```sh
cd plugins/<id>
export npm_config_cache=$TMPDIR/npm-cache
npm install motion                       # the kit's only extra runtime dependency
mkdir -p kit                             # opts the plugin in to `--all`
node ../../kit/scripts/sync.mjs <id>     # copies the kit, then checks prerequisites
```

Then add `"kit"` to `tsconfig.json` `include`. The script prints a `!` line for
anything missing: `motion` and `@radix-ui/react-slot` in `dependencies`,
`@radix-ui/react-popover` and `sonner` in `devDependencies` (host-shimmed,
types only; the scaffold already has them), and the scaffold's
`components/ui/{button,dialog,icon}.tsx`, `lib/utils.ts`,
`lib/portal-scope.ts`.

Use it from your app code:

```tsx
import { useHandoff, HandoffSheet, SentChip, Tint, useHotkeys } from "./kit";
```

Importing `./kit` also pulls in `kit/kit.css` (keyframes and `--kit-*`
properties). Never edit `plugins/<id>/kit/`; the next sync overwrites it.

Picking up later kit changes:

```sh
node ../../kit/scripts/sync.mjs --check --all   # which plugins are stale
node ../../kit/scripts/sync.mjs <id>            # refresh one
npx tsc --noEmit && bb plugin build && bb plugin reload <id>
```

`kit/README.md` documents every export with an example. The gallery
(`/plugins/kit-gallery/gallery`) shows every piece live.

## Screenshots (light, dark, wide, 420 px)

`kit/scripts/shoot.mjs` drives a private headless Chrome (puppeteer-core plus
the `chrome-headless-shell` already in `~/.cache/puppeteer`). The bb server at
`http://127.0.0.1:38886` needs no login from loopback. Light and dark are set
through that browser's own `localStorage["bb.theme"]`, so the user's bb is
never touched.

```sh
cd /Users/marianodsr/projects/bb-plugins
(cd kit/scripts && npm_config_cache=$TMPDIR/npm-cache npm install)   # once
node kit/scripts/shoot.mjs --path /plugins/<id>/<panel-path> \
  --out docs/screenshots/<id> --name board
# writes board-light-1440.png, board-light-420.png, board-dark-1440.png, board-dark-420.png
```

Thread side-panel tab (opens the right panel, then your action tab from its
"Open new tab" page; the panel gets half of what the sidebar leaves, so a
1160 px window gives a 420 px panel and 1920 gives 800 px):

```sh
node kit/scripts/shoot.mjs --path /projects/<projectId>/threads/<threadId> \
  --panel-tab "Review" --widths 1160,1920 --out docs/screenshots/<id> --name review-tab
```

The script prints the measured panel width. Fixed tabs (`availability:
"fixed"`) may already be in the tab strip; `--panel-tab` only knows the
"Open new tab" route, so extend `openPanelTab` if yours is not listed there.

Options: `--widths 1440,420`, `--themes light,dark`, `--height 1000`,
`--click <selector>` (repeatable), `--keys j,j,Enter`, `--scroll <sel>=<y>`,
`--reduced-motion`, `--wait <ms>`. See the header of the script.

Gotchas:

- **Chrome cannot start inside the agent sandbox** (`bootstrap_check_in ...
  Permission denied`). Run the screenshot command with the sandbox disabled.
  Outside the sandbox `$TMPDIR` is a different directory, so write output
  under the repo, not `$TMPDIR`.
- **A page's header actions are shrink-wrapped by bb**, so container queries
  inside `headerContent` resolve against zero width. Size header controls from
  the page body's width (`useContainerWidth` on the body) or the viewport.
- Do not find bb controls by text content: transcript blocks on a thread
  page can contain the same words (this script's own source matched "Send to
  thread"). Use `aria-label`, `aria-keyshortcuts` or `data-*` attributes.
- The `browser-automation` plugin's headless backend fails on this machine
  (`Install Chrome/Chromium on this host or link its executable at the plugin
  data runtime/chrome path`). Linking it would change another plugin's data,
  so the kit uses its own puppeteer script instead.
- At 420 px the bb app switches to its compact layout (sidebar becomes a
  drawer). That is the right check for a plugin page in a narrow window.
- Plugin pages scroll inside their own container, so a full-page screenshot
  does not help. Use `--height` for more content, or `--scroll` to a section.
- Anything with `autoFocus` scrolls the page on load; use
  `focus({ preventScroll: true })`.

Motion checks: `node kit/scripts/handoff-frames.mjs --target thread|current|new|fail`
triggers the gallery's handoff and prints the packet's position per frame,
with screenshots in `docs/screenshots/kit-gallery/handoff/`. Add
`--thread <projectId>/<threadId> --real --width 1160` to run it from that
thread's side panel against the real composer (drafts are the headless
browser's own localStorage, so the user's composer is untouched).

## Open questions, answered

### Do Tailwind palette tints compile and read in light and dark?

They compile: `bg-amber-500/15` becomes
`color-mix(in oklab, var(--color-amber-500) 15%, transparent)`, and the
palette variables are emitted into the plugin CSS. Proven by build output.

**But `dark:` is wrong in bb.** bb switches themes with a `.dark` class on
`<html>` (per client, `localStorage["bb.theme"]`). The plugin build compiles
`dark:` to `@media (prefers-color-scheme: dark)`, the OS setting. When bb's
theme and the OS disagree, `dark:` picks the wrong colours. Use the
class-based variant, which compiles to `:where(.dark) <scope> .x`:

```
bg-amber-500/15 text-amber-700 in-[.dark]:bg-amber-400/15 in-[.dark]:text-amber-300
```

Use the kit's `Tint` (18 hues, `hueFor(label)` for stable label colours),
which does this. Readability is judged in the gallery's Tints section in both
themes (screenshots in `docs/screenshots/kit-gallery/`).

### Which host variables can a plugin use?

All of these compile as Tailwind utilities against live host variables
(proven by build output, values read from the running app):

- Surfaces: `bg-background`, `bg-card`, `bg-muted`, `bg-popover`,
  `bg-accent`, `bg-secondary`, `bg-sidebar`, `bg-surface-raised`,
  `bg-surface-recessed`, `bg-surface-selected`, `bg-state-hover`,
  `bg-state-active`.
- Text: `text-foreground`, `text-muted-foreground`, `text-subtle-foreground`,
  `text-destructive`, `text-destructive-text`, `text-warning-text`,
  `text-pr-merged`.
- Status: `bg-success` (green), `bg-warning` (orange), `bg-attention` (amber),
  `bg-destructive` (red); each with a `-foreground` pair.
- Lines and focus: `border-border`, `ring-ring`.
- Diff: `bg-diff-added`, `bg-diff-removed` (saturated: use as `/15` tints or
  bars), `text-diff-added`, `text-diff-removed`. Full diffs: use
  `experimental_Diff`.
- Shadow: `shadow-lift` is an upward bar shadow (`0 -4px 12px -4px`); for a
  lifted card or the packet use `shadow-lg`.
- Fonts: `font-sans` (host Inter), `font-mono` (host mono stack). There is no
  separate code-font variable and no `font-terminal` utility.
- Syntax colours: not CSS variables. Use `experimental_SourceCode` /
  `experimental_Diff`, or `experimental_useCodeTheme()` for an engine of your
  own (CodeMirror): it returns the live VS Code theme document.
- Do not compile: `font-terminal`, `border-hairline`, `bg-canvas`, `text-ink`.

### Does `motion` bundle cleanly? What does it add?

Yes. `npm install motion` (14.14), no warnings, React stays host-shimmed
(`app.meta.json` `runtimeSlots` unchanged). Measured on a 28 KB scaffold
`app.js`:

| Imports | Added to `app.js` (minified) | gzip |
|---|---|---|
| `animate` from `motion` only | +73 KB | +26 KB |
| `motion/react` (`motion`, `AnimatePresence`, `layout`) plus `animate` | +163 KB | +56 KB |
| Same through `LazyMotion` + `domMax` + `m` | +164 KB | no saving |

The kit uses `motion/react` plus `animate`, so expect about +165 KB.

### `NewThreadComposer` in a dialog, and writing into another composer

- Put it in the vendored `Dialog` (`sm:max-w-2xl`, a bounded-height box,
  `layout="contained"`). The control row needs about 640 px; in a 420 px side
  panel the dialog still uses the window width. On compact viewports the
  vendored Dialog becomes a bottom drawer.
- **Keep every prop stable.** A new `onSubmit` function on each render makes
  the host composer loop until React aborts (error #185, "Composer stopped
  working", a "Composer plugin crashed" toast). Proven by swapping a stable
  callback for an inline arrow. Mount it in a child component that captures
  `initialPrompt`, `defaultProjectId` and `draftKey` once with `useState`, and
  pass a `useCallback` `onSubmit` that reads the latest state from a ref. The
  kit's `HandoffSheet` does this.
- Pass a real `defaultProjectId` (not verified what an unknown id does).
- `initialPrompt` seeds only an empty draft, and drafts persist per
  `draftKey`. Use a key derived from what is being sent (the kit uses the
  sorted item keys), so a different selection starts fresh.
- `onSubmit` receives a `NewThreadRequest`; spread it into
  `sdk.threads.spawn({ ...request, pluginMetadata, title })`. Throwing keeps
  the draft.
- Writing into a thread's composer from another surface: `useComposers()`
  lists the composers on screen; pick
  `c.scope.kind === "thread" && c.scope.threadId === id`, then
  `c.insert(text, { at: "end", block: true }); c.focus()`. If the thread's
  composer is not on screen there is no handle; send instead with
  `sdk.threads.send({ threadId, input: [{ type: "text", text, mentions: [] }], mode: "queue-if-active" })`.
  `threads.send` takes no `pluginMetadata`; set it first with
  `sdk.threads.updatePluginMetadata({ threadId, set })`. The kit's
  `useHandoff` does all of this.
- bb's own DOM markers the kit uses for motion targets, with fallbacks:
  `[data-promptbox-layout]` (prompt box, not a public contract) and
  `[data-sidebar-thread-id]` (documented sidebar row contract).
