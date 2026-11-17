// The thread's Review tab: changed files with their comments, grouped by
// file, each with its state. j/k move, Enter opens, S sends open comments.
import { useCallback, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useBbNavigate, type ExperimentalThreadTabProps } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  EmptyState,
  HandoffSheet,
  Kbd,
  ProgressLine,
  Segmented,
  SentChip,
  ShortcutSheet,
  SkeletonRows,
  Tint,
  useHandoff,
  useHotkeys,
  useKitMotion,
} from "../../kit";
import type { Comment } from "../../server/contract";
import { compilePrompt } from "../../server/prompt";
import { SentTo } from "./CommentNote";
import { useChangedFiles, useCommentWrites, useEnvironmentComments, useHelixStatus, useOpenInHelix } from "../data";
import { SEVERITY_HUE, awaitingAck, groupReview, lineLabel, sendable, type ReviewFilter, type ReviewRow as Row } from "../model/comments";
import { handoffMetadata } from "../model/comments";

type Filter = ReviewFilter;

const KIND_LABEL: Record<string, string> = {
  added: "Added",
  modified: "Modified",
  deleted: "Deleted",
  renamed: "Renamed",
  copied: "Copied",
  type_changed: "Type changed",
};

function CommentState({ comment }: { comment: Comment }) {
  if (awaitingAck(comment)) return <Tint hue="emerald">Resolved by agent</Tint>;
  if (comment.state === "resolved") return <span className="text-xs text-muted-foreground">Resolved</span>;
  if (comment.state === "outdated") return <Tint hue="gray">Outdated</Tint>;
  if (comment.sentThreadId !== null) return <SentTo threadId={comment.sentThreadId} className="max-w-48" />;
  return null;
}

export function ReviewTab({ threadId, environment }: ExperimentalThreadTabProps) {
  const environmentId = environment?.id ?? null;
  const changed = useChangedFiles(environmentId);
  const comments = useEnvironmentComments(environmentId);
  // Helix Bridge: open a changed file in the user's Helix, with the review active.
  const helix = useHelixStatus(environmentId, threadId);
  const openInHelix = useOpenInHelix();
  const helixAvailable = helix.data?.available === true;
  const toHelix = useCallback(
    (path: string) => {
      if (environmentId === null) return;
      openInHelix.mutate({ environmentId, path, ...(threadId ? { threadId } : {}) }).then(
        (result) => (result.opened ? toast.success(result.message) : toast.error(result.message)),
        (cause: unknown) => toast.error(String(cause)),
      );
    },
    [environmentId, openInHelix, threadId],
  );
  const writes = useCommentWrites(environmentId === null ? null : { environmentId, path: "__review__" });
  const navigate = useBbNavigate();
  const { variants, transition } = useKitMotion();
  const [filter, setFilter] = useState<Filter>("open");
  const [cursor, setCursor] = useState(0);
  const page = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<number, HTMLElement>());

  const all = useMemo(() => comments.data?.comments ?? [], [comments.data]);
  const files = changed.data?.outcome === "available" ? changed.data.files : [];
  const groups = useMemo(() => groupReview(files, all, filter), [files, all, filter]);
  const rows = useMemo<Row[]>(
    () => groups.flatMap((group) => [{ kind: "file" as const, group }, ...group.comments.map((comment) => ({ kind: "comment" as const, group, comment }))]),
    [groups],
  );
  const current = rows[Math.min(cursor, rows.length - 1)] ?? null;

  const open = useCallback(
    (row: Row) => {
      if (environmentId === null) return;
      navigate.experimental_openFilePreview({
        target: { kind: "workspace", environmentId, path: row.group.path },
        location: row.kind === "comment" && row.comment.state !== "outdated" ? { kind: "range", startLine: row.comment.startLine, endLine: row.comment.endLine } : null,
        opener: "editor",
      });
    },
    [environmentId, navigate],
  );

  const move = (delta: number) => {
    setCursor((index) => {
      const next = Math.min(Math.max(index + delta, 0), Math.max(rows.length - 1, 0));
      rowRefs.current.get(next)?.scrollIntoView({ block: "nearest" });
      return next;
    });
  };

  const toSend = useMemo(() => sendable(all), [all]);
  const handoff = useHandoff<Comment>({
    items: toSend,
    getKey: (comment) => comment.id,
    buildPrompt: (items) => compilePrompt(items, [{ environmentId: environmentId ?? "", root: null, branch: null }]),
    pluginMetadata: (items) => handoffMetadata(items, environmentId ?? "", Date.now()),
    noun: { one: "comment", many: "comments" },
    currentThreadId: threadId,
    newThreadTitle: (items) => `Review: ${items.length} ${items.length === 1 ? "comment" : "comments"}`,
    onSent: async (result, items) => {
      await writes.markSent.mutate({ commentIds: items.map((comment) => comment.id), threadId: result.threadId });
    },
    hotkey: "s",
  });

  useHotkeys(
    [
      { key: ["j", "ArrowDown"], handler: () => move(1), description: "Next row", group: "Navigation" },
      { key: ["k", "ArrowUp"], handler: () => move(-1), description: "Previous row", group: "Navigation" },
      { key: "Enter", handler: () => current && open(current), description: "Open in the editor", group: "Navigation" },
      {
        key: "x",
        handler: () => {
          if (current?.kind !== "comment") return;
          const fail = (cause: unknown) => toast.error(String(cause));
          if (awaitingAck(current.comment)) {
            writes.acknowledge.mutate({ ids: [current.comment.id] }).catch(fail);
            return;
          }
          const state = current.comment.state === "resolved" ? "open" : "resolved";
          writes.setState.mutate({ id: current.comment.id, state }).catch(fail);
        },
        description: "Mark resolved, acknowledge, or reopen",
        group: "Comments",
        enabled: current?.kind === "comment",
      },
      { key: "a", handler: () => setFilter((value) => (value === "open" ? "all" : "open")), description: "Show resolved comments too", group: "View" },
      { key: "h", handler: () => current && toHelix(current.group.path), description: "Open in Helix", group: "Navigation", enabled: helixAvailable && current !== null },
    ],
    { scope: page },
  );

  if (environmentId === null) {
    return <EmptyState icon="Folder" title="No workspace" description="This thread has no workspace, so there is nothing to review." />;
  }

  const loading = (changed.isLoading || comments.isLoading) && rows.length === 0;
  const shortstat = changed.data?.outcome === "available" ? changed.data.shortstat : null;
  const unavailable = changed.data !== undefined && changed.data.outcome !== "available" ? changed.data.message : null;

  let index = -1;
  return (
    <div ref={page} tabIndex={-1} className="flex h-full min-h-0 flex-col outline-none @container">
      <header className="relative flex h-10 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground tabular-nums">
          {shortstat !== null && shortstat !== "" ? shortstat : unavailable ?? "No uncommitted changes"}
        </span>
        <Segmented
          aria-label="Comments"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "open", label: "Open", title: "Open comments (A)" },
            { value: "all", label: "All", title: "Include resolved (A)" },
          ]}
        />
        <ShortcutSheet />
        <ProgressLine active={(changed.isFetching || comments.isFetching) && !loading} />
      </header>

      <div className="min-h-0 flex-1 overflow-auto py-1">
        {loading ? (
          <SkeletonRows count={6} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon="MessageSquare"
            title="Nothing to review yet"
            description="Changed files and comments in this thread's workspace show here. Open a file and select lines to comment."
          />
        ) : (
          <ul role="listbox" aria-label="Changed files and comments">
            <AnimatePresence initial={false}>
              {groups.map((group) => {
                index += 1;
                const fileIndex = index;
                return (
                  <motion.li key={group.path} layout="position" transition={transition("shift")} variants={variants.listItem} initial="hidden" animate="visible" exit="exit" className="group/file relative">
                    <button
                      ref={(element) => {
                        if (element) rowRefs.current.set(fileIndex, element);
                      }}
                      type="button"
                      role="option"
                      aria-selected={cursor === fileIndex}
                      onClick={() => {
                        setCursor(fileIndex);
                        open({ kind: "file", group });
                      }}
                      className={cn(
                        "flex h-8 w-full items-center gap-2 px-3 text-left transition-colors duration-[120ms] hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
                        cursor === fileIndex && "bg-surface-selected/60",
                      )}
                      title={group.change ? KIND_LABEL[group.change.changeKind] ?? group.change.changeKind : "Unchanged, with comments"}
                    >
                      <span
                        aria-hidden
                        className={cn(
                          "size-1.5 shrink-0 rounded-full",
                          group.change === null
                            ? "bg-transparent ring-1 ring-muted-foreground/60"
                            : group.change.changeKind === "added"
                              ? "bg-diff-added"
                              : group.change.changeKind === "deleted"
                                ? "bg-diff-removed"
                                : "bg-attention",
                        )}
                      />
                      <span className="min-w-0 flex-1 truncate font-mono text-xs">
                        <span className="text-muted-foreground">{group.path.slice(0, group.path.lastIndexOf("/") + 1)}</span>
                        <span className="text-foreground">{group.path.slice(group.path.lastIndexOf("/") + 1)}</span>
                      </span>
                      {group.change !== null ? (
                        <span className="shrink-0 text-xs tabular-nums">
                          <span className="text-diff-added">+{group.change.additions}</span>{" "}
                          <span className="text-diff-removed">-{group.change.deletions}</span>
                        </span>
                      ) : null}
                    </button>
                    {helixAvailable ? (
                      <button
                        type="button"
                        onClick={() => toHelix(group.path)}
                        className={cn(
                          "absolute right-16 top-1 hidden h-6 items-center rounded-md border border-border/60 bg-background px-2 text-xs text-muted-foreground hover:text-foreground focus-visible:inline-flex focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover/file:inline-flex",
                          cursor === fileIndex && "inline-flex",
                        )}
                        title="Open in Helix, with the review active (H)"
                        data-open-in-helix
                      >
                        Open in Helix
                      </button>
                    ) : null}
                    {group.comments.length > 0 ? (
                      <ul className="pb-1">
                        {group.comments.map((comment) => {
                          index += 1;
                          const rowIndex = index;
                          const hue = SEVERITY_HUE[comment.severity];
                          return (
                            <li key={comment.id}>
                              <button
                                ref={(element) => {
                                  if (element) rowRefs.current.set(rowIndex, element);
                                  handoff.itemRef(comment.id)(element);
                                }}
                                type="button"
                                role="option"
                                aria-selected={cursor === rowIndex}
                                onClick={() => {
                                  setCursor(rowIndex);
                                  open({ kind: "comment", group, comment });
                                }}
                                className={cn(
                                  "flex h-7 w-full items-center gap-2 pr-3 pl-6 text-left transition-colors duration-[120ms] hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
                                  cursor === rowIndex && "bg-surface-selected/60",
                                  comment.state === "resolved" && !awaitingAck(comment) && "text-muted-foreground",
                                )}
                              >
                                <span
                                  aria-hidden
                                  className={cn(
                                    "h-3.5 w-0.5 shrink-0 rounded-full",
                                    hue === null ? "bg-muted-foreground/50" : hue === "sky" ? "bg-sky-500" : hue === "amber" ? "bg-attention" : "bg-destructive",
                                  )}
                                />
                                <span className="w-16 shrink-0 text-xs text-muted-foreground tabular-nums">{lineLabel(comment).replace("Lines ", "L").replace("Line ", "L")}</span>
                                <span className={cn("min-w-0 flex-1 truncate text-sm", comment.state === "resolved" && !awaitingAck(comment) && "line-through decoration-muted-foreground/40")}>
                                  {comment.body}
                                </span>
                                {awaitingAck(comment) ? (
                                  <span className="shrink-0 text-xs text-success-foreground @[420px]:hidden">Resolved by agent</span>
                                ) : comment.replies.some((reply) => reply.author === "agent") ? (
                                  <span className="shrink-0 text-xs text-muted-foreground">Agent replied</span>
                                ) : null}
                                <span className="hidden shrink-0 @[420px]:inline-flex">
                                  <CommentState comment={comment} />
                                </span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    ) : null}
                  </motion.li>
                );
              })}
            </AnimatePresence>
          </ul>
        )}
      </div>

      <footer className="flex h-11 shrink-0 items-center gap-2 border-t border-border/60 px-3">
        <span className="text-xs text-muted-foreground tabular-nums">
          {[
            toSend.length === 0 ? "No comments to send" : `${toSend.length} to send`,
            ...(all.some(awaitingAck) ? [`${all.filter(awaitingAck).length} resolved by agent`] : []),
          ].join(", ")}
        </span>
        <span className="hidden items-center gap-1 text-xs text-muted-foreground @[420px]:flex">
          <Kbd>J</Kbd>
          <Kbd>K</Kbd> to move, <Kbd>Enter</Kbd> to open
        </span>
        <span className="min-w-0 flex-1" />
        <SentChip result={handoff.lastResult} />
        <HandoffSheet handoff={handoff} />
      </footer>
    </div>
  );
}

export function useReviewTabVisible({ environment }: ExperimentalThreadTabProps): boolean {
  const environmentId = environment?.id ?? null;
  const changed = useChangedFiles(environmentId);
  const comments = useEnvironmentComments(environmentId);
  if (environmentId === null) return false;
  const changes = changed.data?.outcome === "available" ? changed.data.files.length : 0;
  return changes > 0 || (comments.data?.comments.length ?? 0) > 0;
}

