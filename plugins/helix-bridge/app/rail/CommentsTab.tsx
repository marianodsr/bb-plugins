// The rail's Comments tab: every comment of this thread's review, grouped by
// file, with the quoted lines, its state and the agent's replies under it.
// Enter (or a click on the lines) takes Helix there; a comment is edited,
// dropped, answered, reopened or acknowledged in place; Send to thread at the
// foot hands the ones not sent yet to the agent.
import { useEffect, useMemo, useRef, useState } from "react";
import type { RailComment } from "../../server";
import { cn } from "@/lib/utils";
import { EmptyState, ShortcutHint, SkeletonRows, useHotkeys } from "../../kit";
import { useHelixRpc } from "../data";
import { SendToThread } from "../review/SendToThread";
import { hideOptimistic, refetchComments, useComments } from "./commentsStore";
import { editorFocus } from "./railStore";

const STATE: Record<RailComment["state"], { label: string; className: string }> = {
  unsent: { label: "Not sent", className: "text-foreground" },
  sent: { label: "Sent", className: "text-muted-foreground" },
  answered: { label: "Answered", className: "text-foreground" },
  resolved: { label: "Resolved by the agent", className: "text-foreground" },
  outdated: { label: "Outdated", className: "text-muted-foreground" },
  done: { label: "Done", className: "text-muted-foreground" },
};

/** Needs the owner first, then what is waiting to be sent, then the rest. */
const ORDER: Record<RailComment["state"], number> = { answered: 0, resolved: 0, unsent: 1, sent: 2, outdated: 3, done: 4 };

function lines(c: RailComment): string {
  return c.startLine === c.endLine ? `line ${c.startLine}` : `lines ${c.startLine}-${c.endLine}`;
}

export function CommentsTab({ threadId, onLeave }: { threadId: string; onLeave?(): void }) {
  const rpc = useHelixRpc();
  const { data, error } = useComments(threadId);
  const [showDone, setShowDone] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [editing, setEditing] = useState<{ id: string; mode: "edit" | "reply" } | null>(null);
  const [confirmDrop, setConfirmDrop] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);

  const visible = useMemo(() => {
    const all = (data?.comments ?? []).filter((c) => showDone || c.state !== "done");
    return all.sort((a, b) => a.path.localeCompare(b.path) || ORDER[a.state] - ORDER[b.state] || a.startLine - b.startLine);
  }, [data, showDone]);
  const done = (data?.comments ?? []).filter((c) => c.state === "done").length;
  const at = Math.min(cursor, Math.max(0, visible.length - 1));
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
    onLeave?.();
    editorFocus.get(threadId)?.();
  };

  useHotkeys(
    [
      { key: ["j", "ArrowDown"], handler: () => setCursor((c) => Math.min(visible.length - 1, c + 1)), description: "Next comment", group: "Comments" },
      { key: ["k", "ArrowUp"], handler: () => setCursor((c) => Math.max(0, c - 1)), description: "Previous comment", group: "Comments" },
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
            const header = c.path !== lastPath ? c.path : null;
            lastPath = c.path;
            const selected = index === at;
            const state = STATE[c.state];
            return (
              <div key={c.id} role="listitem">
                {header ? <div className="truncate px-1.5 pb-1 pt-2 font-mono text-xs text-muted-foreground">{header}</div> : null}
                <article
                  data-index={index}
                  data-helix-comment-state={c.state}
                  onMouseDown={() => setCursor(index)}
                  className={cn("mb-1 flex flex-col gap-1.5 rounded-lg px-2 py-1.5 text-xs transition-colors duration-[120ms]", selected ? "bg-state-hover" : "hover:bg-state-hover/60")}
                >
                  <div className="flex items-center gap-2">
                    <button type="button" onClick={() => jump(c)} className="font-mono tabular-nums text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" title="Show these lines in Helix (Enter)">
                      {lines(c)}
                    </button>
                    <span className={cn("ml-auto shrink-0", state.className)}>{state.label}</span>
                  </div>
                  {c.snippet ? (
                    <pre className="max-h-16 overflow-hidden whitespace-pre rounded-md border-l-2 border-border bg-muted/60 px-2 py-1 font-mono text-[11px] leading-4 text-muted-foreground">{c.snippet.split("\n").slice(0, 3).join("\n")}</pre>
                  ) : null}
                  {editing?.id === c.id && editing.mode === "edit" ? (
                    <InlineText
                      initial={c.body}
                      label="Save"
                      onDone={(text) => {
                        setEditing(null);
                        if (text !== null && text !== c.body) act(c, "edit", text);
                        list.current?.focus();
                      }}
                    />
                  ) : (
                    <p className="whitespace-pre-wrap leading-5">{c.body}</p>
                  )}
                  {c.replies.map((r, i) => (
                    <p key={i} className="whitespace-pre-wrap border-l-2 border-border pl-2 leading-5 text-muted-foreground">
                      <span className="text-foreground">{r.author === "agent" ? "Agent" : "You"}:</span> {r.body}
                    </p>
                  ))}
                  {editing?.id === c.id && editing.mode === "reply" ? (
                    <InlineText
                      initial=""
                      label="Reply"
                      onDone={(text) => {
                        setEditing(null);
                        if (text) act(c, "reply", text);
                        list.current?.focus();
                      }}
                    />
                  ) : null}
                  {selected && editing === null ? <Actions comment={c} confirmDrop={confirmDrop === c.id} /> : null}
                </article>
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

function Actions({ comment, confirmDrop }: { comment: RailComment; confirmDrop: boolean }) {
  const items: { combo: string; label: string }[] = [];
  if (comment.state === "unsent" || comment.state === "sent") items.push({ combo: "e", label: "edit" });
  if (!comment.local && comment.state !== "unsent") items.push({ combo: "r", label: "reply" });
  if (comment.state === "resolved") items.push({ combo: "a", label: "got it" });
  if (comment.state === "resolved" || comment.state === "done") items.push({ combo: "o", label: "reopen" });
  items.push({ combo: "d", label: confirmDrop ? "press d again to drop" : "drop" });
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {items.map((i) => (
        <ShortcutHint key={i.combo} combo={i.combo} label={i.label} className={i.combo === "d" && confirmDrop ? "text-destructive" : undefined} />
      ))}
    </div>
  );
}

/** Edit or reply in place: Enter keeps it, Shift+Enter is a new line, Escape leaves it as it was. */
function InlineText({ initial, label, onDone }: { initial: string; label: string; onDone(text: string | null): void }) {
  const [text, setText] = useState(initial);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  return (
    <textarea
      ref={area}
      value={text}
      aria-label={label}
      rows={Math.min(6, Math.max(2, text.split("\n").length))}
      onChange={(event) => setText(event.target.value)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          onDone(null);
        } else if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          onDone(text.trim() || null);
        }
      }}
      onBlur={() => onDone(null)}
      className="w-full resize-none rounded-md border border-border/60 bg-background px-2 py-1 text-xs leading-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    />
  );
}
