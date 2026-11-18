// The rail's Comments tab: every comment of this thread's review, grouped by
// file, with the quoted lines, its state and the agent's replies under it
// (CommentCard draws them).
// Enter (or a click on the lines) takes Helix there; a comment is edited,
// dropped, answered, reopened or acknowledged in place; Send to thread at the
// foot hands the ones not sent yet to the agent.
import { useEffect, useMemo, useRef, useState } from "react";
import type { RailComment } from "../../server";
import { EmptyState, ShortcutHint, SkeletonRows, useHotkeys } from "../../kit";
import { CommentCard, FileHeader } from "./CommentCard";
import { useHelixRpc } from "../data";
import { SendToThread } from "../review/SendToThread";
import { hideOptimistic, refetchComments, useComments } from "./commentsStore";
import { railMemory, useKeyedCursor } from "./railMemory";
import { editorFocus } from "./railStore";

/** Needs the owner first, then what is waiting to be sent, then the rest. */
const ORDER: Record<RailComment["state"], number> = { answered: 0, resolved: 0, unsent: 1, sent: 2, outdated: 3, done: 4 };

export function CommentsTab({ threadId, onLeave }: { threadId: string; onLeave?(): void }) {
  const rpc = useHelixRpc();
  const { data, error } = useComments(threadId);
  // Where this was when the rail closed: the same comment, the same filter.
  const memory = railMemory(threadId).comments;
  const [showDone, setShowDoneState] = useState(memory.showDone);
  const setShowDone = (update: (shown: boolean) => boolean) =>
    setShowDoneState((shown) => {
      memory.showDone = update(shown);
      return memory.showDone;
    });
  const [editing, setEditing] = useState<{ id: string; mode: "edit" | "reply" } | null>(null);
  const [confirmDrop, setConfirmDrop] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);

  const visible = useMemo(() => {
    const all = (data?.comments ?? []).filter((c) => showDone || c.state !== "done");
    return all.sort((a, b) => a.path.localeCompare(b.path) || ORDER[a.state] - ORDER[b.state] || a.startLine - b.startLine);
  }, [data, showDone]);
  const done = (data?.comments ?? []).filter((c) => c.state === "done").length;
  const perFile = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of visible) counts.set(c.path, (counts.get(c.path) ?? 0) + 1);
    return counts;
  }, [visible]);
  const { at, setAt: setCursor } = useKeyedCursor(visible, (c) => c.id, memory.row, (id) => (memory.row = id));
  const current = visible[at] ?? null;

  const act = (comment: RailComment, action: "edit" | "delete" | "reply" | "reopen" | "resolve" | "acknowledge", body?: string) => {
    setFailure(null);
    if (action === "delete" || action === "acknowledge") hideOptimistic(threadId, comment.id, true);
    void rpc.call("commentAction", { threadId, commentId: comment.id, action, ...(body ? { body } : {}) }).then(
      () => refetchComments(rpc, threadId),
      (cause: unknown) => {
        hideOptimistic(threadId, comment.id, false);
        setFailure(cause instanceof Error ? cause.message : String(cause));
      },
    );
  };
  const jump = (c: RailComment) => {
    void rpc.call("openChange", { threadId, path: c.path, line: c.startLine }).catch(() => {});
    // The rail comes back on this comment.
    memory.row = c.id;
    onLeave?.();
    editorFocus.get(threadId)?.();
  };

  useHotkeys(
    [
      { key: ["j", "ArrowDown"], handler: () => setCursor(Math.min(visible.length - 1, at + 1)), description: "Next comment", group: "Comments" },
      { key: ["k", "ArrowUp"], handler: () => setCursor(Math.max(0, at - 1)), description: "Previous comment", group: "Comments" },
      { key: "Enter", handler: () => current && jump(current), description: "Show its lines in Helix", group: "Comments" },
      { key: "e", handler: () => current && (current.state === "unsent" || current.state === "sent") && setEditing({ id: current.id, mode: "edit" }), description: "Edit", group: "Comments" },
      { key: "r", handler: () => current && !current.local && setEditing({ id: current.id, mode: "reply" }), description: "Reply", group: "Comments" },
      {
        key: "d",
        handler: () => {
          if (!current) return;
          if (confirmDrop === current.id) {
            setConfirmDrop(null);
            act(current, "delete");
          } else setConfirmDrop(current.id);
        },
        description: "Drop (press twice)",
        group: "Comments",
      },
      { key: "a", handler: () => current?.state === "resolved" && act(current, "acknowledge"), description: "Acknowledge the agent's resolution", group: "Comments" },
      { key: "o", handler: () => current && (current.state === "resolved" || current.state === "done") && act(current, "reopen"), description: "Reopen", group: "Comments" },
    ],
    { scope: list, enabled: editing === null },
  );

  useEffect(() => setConfirmDrop(null), [at]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${at}"]`)?.scrollIntoView({ block: "nearest" });
  }, [at]);

  if (!data) return error ? <EmptyState icon="AlertCircle" tone="error" title="The comments could not be read" description={error} /> : <SkeletonRows count={5} />;

  let lastPath = "";
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-helix-comments>
      {data.source === "local" && data.comments.length > 0 ? (
        <p className="mx-2 mb-2 rounded-md bg-muted px-2 py-1.5 text-xs leading-5 text-muted-foreground">Review Editor is not running: comments are kept here until it is, and replies wait for it.</p>
      ) : null}
      {failure ? (
        <p className="mx-2 mb-2 rounded-md bg-muted px-2 py-1.5 text-xs leading-5 text-destructive" role="status">
          {failure}
        </p>
      ) : null}
      <div ref={list} tabIndex={0} data-rail-focus className="min-h-0 flex-1 overflow-y-auto px-1 pb-2 focus-visible:outline-none" aria-label="Comments" role="list">
        {visible.length === 0 ? (
          <EmptyState
            icon="MessageSquare"
            title={done > 0 ? "Nothing waits for you" : "No comments yet"}
            description={done > 0 ? "Every comment is done." : "Select lines in Helix and press your comment key (:bb-comment) to write one here."}
          />
        ) : (
          visible.map((c, index) => {
            const header = c.path !== lastPath;
            lastPath = c.path;
            const mode = editing?.id === c.id ? editing.mode : null;
            return (
              <div key={c.id} role="listitem">
                {header ? <FileHeader path={c.path} count={perFile.get(c.path) ?? 0} /> : null}
                <CommentCard
                  comment={c}
                  index={index}
                  selected={index === at}
                  editing={mode}
                  confirmDrop={confirmDrop === c.id}
                  onPick={() => setCursor(index)}
                  onOpen={() => jump(c)}
                  onEdited={(text) => {
                    setEditing(null);
                    if (text !== null && text !== c.body) act(c, "edit", text);
                    list.current?.focus();
                  }}
                  onReplied={(text) => {
                    setEditing(null);
                    if (text) act(c, "reply", text);
                    list.current?.focus();
                  }}
                />
              </div>
            );
          })
        )}
        {done > 0 ? (
          <button type="button" onClick={() => setShowDone((v) => !v)} className="mx-1.5 mt-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {showDone ? "Hide done" : `${done} done`}
          </button>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-border/60 px-2.5 py-1.5">
        <SendToThread threadId={threadId} />
        <span className="ml-auto flex items-center gap-3">
          <ShortcutHint combo="Enter" label="show" />
          <ShortcutHint combo="?" label="keys" />
        </span>
      </div>
    </div>
  );
}
