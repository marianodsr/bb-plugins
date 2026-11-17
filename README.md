# bb plugins

Four plugins for [bb](https://getbb.app), built on one shared design kit.

| Plugin | What it does |
|---|---|
| [Review Editor](plugins/review-editor) | Edit workspace files, see their git changes, comment on line ranges, and send the comments to a thread whose agent replies to and resolves each one. |
| [Task Board](plugins/task-board) | A kanban of tasks per project. Tasks start threads, show what their threads are doing, and agents can read and move their own task. |
| [Jira Viewer](plugins/jira-viewer) | Read Jira Cloud issues beside the chat: saved views, an issue reader, and issues as agent context. Read-only. |
| [Helix Bridge](plugins/helix-bridge) | Runs a [fork of the Helix editor](https://github.com/marianodsr/helix/tree/bb-bridge/bb-bridge) inside bb on Ghostty's terminal core and connects it to your threads: bb knows the file and line you are on, you send selections and comments to the agent from Helix, the agent can take you to code, and its edits appear in the editor as it makes them. |
| [Kit Gallery](plugins/kit-gallery) | Dev-only page that renders every piece of the shared kit. |

## Install

Each plugin installs from its subdirectory:

```sh
bb plugin install git:https://github.com/marianodsr/bb-plugins.git@main --subdirectory plugins/review-editor
bb plugin install git:https://github.com/marianodsr/bb-plugins.git@main --subdirectory plugins/task-board
bb plugin install git:https://github.com/marianodsr/bb-plugins.git@main --subdirectory plugins/jira-viewer
```

Helix Bridge needs the editor fork. One command installs the editor, the
plugin and the Review Editor it uses for comments:

```sh
curl -fsSL https://raw.githubusercontent.com/marianodsr/helix/bb-bridge/bb-bridge/install.sh | sh
```

Jira Viewer needs a Jira Cloud site, account email and API token, entered in
Settings → Installed plugins → Jira Viewer. Run `bb jira-viewer check` after
saving them.

## Layout

```
kit/              shared design layer: motion tokens, components, the handoff
plugins/<id>/     one plugin each; plugins/<id>/kit/ is a generated copy of kit/
docs/DESIGN.md    design language all three follow
docs/CONVENTIONS.md  build, install and verification notes
PLAN.md           scope, data models and the contracts between plugins
```

The kit is copied into each plugin because bb builds a plugin from its own
directory. Edit `kit/`, then run `node kit/scripts/sync.mjs <id>`.

## Develop

```sh
cd plugins/<id>
npm install --include=dev
npx tsc --noEmit && npx vitest run && bb plugin build
bb plugin install . --yes
```

## Status

Built and verified against bb 0.49.0. Jira Viewer has been tested against a
mock Jira server only, not a real site. Helix Bridge has been verified against
the fork's `bb-bridge` branch on macOS (Apple silicon).
