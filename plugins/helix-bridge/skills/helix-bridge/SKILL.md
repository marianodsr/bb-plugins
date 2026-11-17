---
name: helix-bridge
description: Show the user code in their Helix editor - "take me to", "show me where", "walk me through", "open in my editor".
---

# Showing the user code in Helix

The user edits in Helix, connected to this thread. To take them somewhere,
find the place yourself (search, read, your own tools), then:

```sh
bb hx open internal/auth/session.go:42-58 --note "token refresh starts here"
```

`path:line` or `path:line-endLine`, relative to the workspace. It prints
where they landed. For several places in order:

```sh
bb hx tour --title "Request flow" "cmd/server/main.go:31 entry point" "internal/http/router.go:88 routes" "internal/auth/session.go:42 auth check"
```

Each stop is `"path:line[-endLine] note"`; they continue with `:bb-next`.
Many stops: one per line with `--stops-stdin`.

End your answer with one line saying where the user is now.

- **Deferred** in the output is not a failure: they were typing, and Helix
  offers `:bb-go` to make the jump. Tell them; add `--now` only if they asked
  to be moved at once.
- **No Helix is connected to this thread**: say so; they open it from the
  thread's Helix button.
- Do not edit through Helix: change files with your normal tools; Helix
  shows the change by itself.
