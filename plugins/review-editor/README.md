# bb-plugin-review-editor

Review Editor: edit workspace files, see their git changes, comment on line
ranges, and hand the comments to a thread whose agent replies to and resolves
each one. Plugin id `review-editor`.

Status: phases A and B done. See `DECISIONS.md` and `../../PLAN.md`.

## Layout

- `server.ts`: wiring (RPC, CLI, tools, agent configuration, environment change watch).
- `server/contract.ts`: RPC contract, boundary schemas, tags. `app.tsx` imports its type only.
- `server/service.ts`: every operation, shared by RPC, CLI and tools.
- `server/anchor.ts`: comment re-anchoring (pure).
- `server/prompt.ts`: the handoff prompt (pure).
- `server/store.ts`: SQLite schema and queries.
- `server/cli.ts`, `server/tools.ts`: `bb review` and the `review_*` tools.
- `app.tsx`: registrations (file opener, Review tab, palette command).
- `app/components/`: the editor page, notes, chrome, split diff, Review tab.
- `app/editor/`: CodeMirror controller, change bars, comment layer, theme, languages, `editor.css`.
- `app/model/`: pure UI logic (doc state, rail layout, comment walk, languages), unit-tested.
- `app/data.ts`, `app/contract.ts`: live RPC reads, optimistic writes, the zod-free client contract.
- `kit/`: generated copy of the shared kit (`node ../../kit/scripts/sync.mjs review-editor`).
- `scripts/`: headless Chrome drivers for live checks and screenshots (run outside the sandbox).
- `skills/review-editor/SKILL.md`: agent instructions.

## Develop

```sh
export npm_config_cache=$TMPDIR/npm-cache
npm install --include=dev
npm run typecheck && npm test && bb plugin build
bb plugin install . --yes      # then: bb plugin reload review-editor
```
