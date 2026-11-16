# Review Editor decisions

Choices not covered by PLAN.md, taken conservatively. Newest last.

## Phase A

1. **Files are addressed as `{ environmentId, path }`**, path relative to the
   workspace root, validated (no `..`, not absolute, no `./`, no backslash).
   The host and root come from `environments.get`; every read and write goes
   through `bb.sdk.files` with that `hostId` and `rootPath`. A `fileOpener`
   `host` source maps to an environment with `resolveHostFile` (deepest root
   wins). `thread-storage` files and host paths outside any environment are
   left to BB's own preview (`Original`) in phase B.
2. **Saves need `expectedSha256`** (a sha, or null for create-only). There is
   no unconditional save in the contract. A conflict is a result
   (`{ outcome: "conflict", currentSha256 }`), not an error, so the UI can offer
   reload or merge.
3. **Anchoring keeps file snapshots.** Besides the plan's range, snippet and
   sha, the plugin stores the file content each anchor was computed against
   (`file_snapshots`, deduplicated by sha, garbage-collected when no comment
   refers to it, skipped above 2 MB). With it a line diff tracks the exact
   range even with duplicate code, and a comment whose own code changed goes
   outdated instead of jumping onto another copy. Without it (large files),
   search falls back to exact then whitespace-insensitive, nearest to the old
   line. A whitespace-only match updates the stored snippet to the current
   code.
4. **Re-anchoring runs on read**: `readFile`, `saveFile`, `syncAnchors`, the
   CLI's `comments`/`show`/`prompt`, and `review_list_comments`. No background
   job. An outdated comment comes back (to `open` or `sent`) if its code
   reappears. Resolved comments move with their code but never go outdated.
   A deleted file outdates its unresolved comments.
5. **Extra columns** beyond the plan: `sent_at`, `resolved_at`, `resolved_by`
   on comments; `id` and `author_thread_id` on replies. `thread_id` is the
   thread the editor was opened from (nullable).
6. **Severities**: `note` (default), `suggestion`, `issue`, `blocker`.
7. **Agent tools are always offered** by `agents.configure`, not only when the
   thread has sent comments: BB never adds tools to a running session, so
   gating would hide them from the thread that just received comments. The
   configure instruction appears only when the thread holds unresolved
   comments, and the compiled prompt names the tools and the `bb review`
   fallback. Verified live: tools registered after a session starts do not
   reach it.
8. **Tool authorization**: `review_reply` and `review_resolve` act only on
   comments whose `sent_thread_id` is the calling thread. Thread metadata
   (`review: { version, environmentId, commentIds, sentAt }`) is written on
   send and only ever used, after schema validation, to count comments for the
   instruction in the gap between a new thread's spawn and `markSent`; it
   never grants access.
9. **The CLI is not restricted** like the tools: it is the user's surface.
   When run inside a thread (`ctx.threadId`), replies and resolutions are
   recorded as `agent` from that thread; otherwise as `user`.
10. **`bb review` and `review_*` are free**: no core `review` command, and no
    installed or upstream plugin uses the `review_` prefix (`diff-review` uses
    `diff_review_*`).
11. **External changes**: the server subscribes to `environment:changed` and
    invalidates `files:<env>` and `git:<env>` on `work-status-changed`
    (verified live to fire on plain file edits, also in a non-git
    environment), `git:<env>` on ref and branch changes.
12. **Comments are kept when an environment is removed.** Nothing deletes
    them yet; see open questions.
13. **The spike opener registers no extensions** (`extensions: []`), so the
    plugin never takes over a file type until phase B decides how it is
    opened (another installed plugin, `monaco-editor`, may also register
    openers). Superseded in phase B by 25.

## Phase B

14. **Keys inside and outside the editor.** Typing wins inside CodeMirror:
    there the keys are `⌘S` save, `⌥⌘M` comment on the selection, `F8` and
    `⇧F8` next and previous comment, `Esc` (after clearing a selection)
    leaves the editor for the page. On the page the single keys of DESIGN.md
    work: `C` comment, `]` `[` walk, `R` reply, `X` resolve or reopen, `H`
    resolved on or off, `E` `D` Edit and Diff, `U` unified or split, `S` Send
    to thread, `Enter` back to the code, `?` the sheet. The selection
    toolbar shows `⌥⌘M`.
15. **Layout thresholds**: margin rail at 880 px of container width and
    above, folded notes below; split diff offered from 720 px. Notes never
    overlap; the active one keeps its line, others make room
    (`app/model/rail.ts`).
16. **Commenting on an unsaved buffer saves first**, so the stored line range
    and snippet match the file on disk. A conflict stops the comment and
    shows the conflict banner.
17. **Split diff is read-only.** Edit in Edit or the unified diff; split is
    for reading. Switching keeps the top line in view.
18. **The Review tab is a fixed thread tab shown only when the thread's
    environment has changed files or comments**, so threads without review
    work do not gain an empty tab. The palette command opens it.
19. **The frontend contract has no zod.** The live RPC hooks validate input
    only to compute tags, so `app/contract.ts` pairs every method with a
    pass-through schema and the server's own tag functions
    (`server/tags.ts`). A test fails if a server method is missing on the
    client or a tag differs. This cut 454 KB of minified bundle.
20. **Bundle**: `app.js` is 1.1 MB minified, 373 KB gzipped: CodeMirror with
    about 25 languages (Lezer grammars for JS/TS, JSON, CSS, HTML,
    Markdown, Python, YAML; stream modes for the rest) and the kit's
    `motion`. No code splitting in plugin bundles, so languages are static.
21. **The editor surface is bb's background**; only text and syntax colours
    come from the code theme (`experimental_useCodeTheme`). Diff, change
    bars and comment tints use host variables (`--diff-added`,
    `--diff-removed`, `--attention`, `--destructive`).
22. **Resolved comments are hidden by default** (`H` shows them); an
    agent's resolution makes the note leave the rail with an exit
    animation, and the tray count says how many are resolved.
23. **Dev seam for live checks**: `localStorage["review-editor.devBaseRef"]`
    makes the editor diff against another ref (used to screenshot diffs
    against `HEAD~1` in a read-only checkout with no uncommitted changes).
    Unset, the base is always `HEAD`. Only my private headless profile ever
    set it.
24. **Built locally, not in the kit**: `NoteField` (a growing multi-line
    field with a severity row, `⌘Enter` to submit; the kit's
    `InlineComposer` has no slot for the severity row), the selection
    toolbar, the file banners, and `SentTo` (a `ThreadChip` that fetches the
    title of an archived thread, which the live sidebar no longer has).
25. **Extensions claimed** by the opener: code, config, markup, Markdown and
    plain text (`app/model/languages.ts`); images and tables (svg, csv, tsv,
    plist) stay with bb's preview. Binary and very large files fall back to
    bb's preview; so do thread-storage files and host paths outside any
    environment.
26. **"Resolved by agent" waits for the reviewer.** An agent's resolution
    sets `acknowledged_at` to null (a user's resolution acknowledges at
    once). The note stays in the rail with the agent's note until the
    reviewer presses `X` (Acknowledge), reopens it, or leaves the file. The
    tray and the Review tab count and list these. "Leaving" counts only
    resolutions that were on screen for a second, and waits 1.5 s so the
    host's unmount and remount of a tab on open does not count (found live:
    without the grace, opening the file acknowledged them).
