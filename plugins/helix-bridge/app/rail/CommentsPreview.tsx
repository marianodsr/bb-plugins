// The comment cards on made-up comments, at the rail's width, with no Helix
// and no thread behind them: `/plugins/helix-bridge/editor/~comments`. It is
// how their look is checked in light and dark (kit/scripts/shoot.mjs); nothing
// links to it.
import { useState } from "react";
import type { RailComment } from "../../server";
import { CommentCard, FileHeader } from "./CommentCard";

export const PREVIEW_PATH = "~comments";

const base: Pick<RailComment, "severity" | "replies" | "local" | "updatedAt"> = { severity: "note", replies: [], local: false, updatedAt: 0 };
const COMMENTS: RailComment[] = [
  {
    ...base,
    id: "rc_1",
    path: "services/auth/session.go",
    startLine: 41,
    endLine: 46,
    snippet: '\tfunc (s *Store) Refresh(ctx context.Context, id string) (*Session, error) {\n\t\tsess, ok := s.cache[id]\n\t\tif !ok || sess.Expired(time.Now()) {\n\t\t\treturn nil, ErrNoSession // caller retries\n\t\t}\n\t\treturn sess, nil',
    body: "This returns `ErrNoSession` for an expired session too. The caller cannot tell the two apart.",
    severity: "blocker",
    state: "answered",
    replies: [{ author: "agent", body: "Agreed. I split it: `ErrNoSession` when the id is unknown, `ErrExpired` otherwise, and `Refresh` now wraps both with `%w`.", at: 0 }],
  },
  { ...base, id: "rc_2", path: "services/auth/session.go", startLine: 88, endLine: 88, snippet: "const defaultTTL = 15 * time.Minute", body: "Should this come from config?", severity: "suggestion", state: "unsent" },
  {
    ...base,
    id: "rc_3",
    path: "web/src/components/TokenBadge.tsx",
    startLine: 12,
    endLine: 16,
    snippet: '  export function TokenBadge({ token }: { token: Token | null }) {\n    if (!token) return null;\n    const label = token.expiresAt < Date.now() ? "expired" : `valid ${ago(token.issuedAt)}`;\n    return <Badge tone={label === "expired" ? "warn" : "ok"}>{label}</Badge>;\n  }',
    body: "Compare against the server's clock, not `Date.now()`.",
    severity: "issue",
    state: "resolved",
    replies: [
      { author: "agent", body: "Done: the badge takes `now` from the session response.\n\n```ts\nconst label = token.expiresAt < now ? \"expired\" : `valid ${ago(token.issuedAt)}`;\n```", at: 0 },
      { author: "user", body: "> takes `now` from the session response\n\nGood, thanks.", at: 0 },
    ],
  },
  { ...base, id: "rc_4", path: "web/src/components/TokenBadge.tsx", startLine: 3, endLine: 3, snippet: 'import { ago } from "../lib/time";', body: "Sent, waiting.", state: "sent" },
  { ...base, id: "rc_5", path: "docs/sessions.md", startLine: 7, endLine: 9, snippet: "## Expiry\n\nA session lives for **15 minutes** unless `Refresh` is called.", body: "Mention the new error here.", state: "outdated" },
  { ...base, id: "rc_6", path: "BUILD.bazel", startLine: 20, endLine: 24, snippet: 'go_library(\n    name = "auth",\n    srcs = ["session.go", "token.go"],\n    deps = ["//lib/clock"],\n)', body: "Fine as it is.", state: "done" },
];

export function CommentsPreview() {
  const [at, setAt] = useState(0);
  const counts = new Map<string, number>();
  for (const c of COMMENTS) counts.set(c.path, (counts.get(c.path) ?? 0) + 1);
  let last = "";
  return (
    <div className="flex min-h-0 flex-1 justify-center overflow-y-auto bg-muted/40 p-6">
      <div className="h-fit w-[22rem] border-r border-border/60 bg-background px-1 pb-2 shadow-lg" data-helix-comments-preview>
        {COMMENTS.map((c, index) => {
          const header = c.path !== last;
          last = c.path;
          return (
            <div key={c.id}>
              {header ? <FileHeader path={c.path} count={counts.get(c.path) ?? 0} /> : null}
              <CommentCard comment={c} index={index} selected={index === at} editing={null} confirmDrop={false} onPick={() => setAt(index)} onOpen={() => {}} onEdited={() => {}} onReplied={() => {}} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
