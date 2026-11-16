// A comment as a note in the margin (or folded under its line): severity,
// state, body, replies, and the reply/resolve actions. Flat on the surface;
// the active note is marked by a severity-coloured edge, not a shadow.
import { forwardRef, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { useSdk } from "@get-bb/plugin-sdk/app";
import { Collapse, Kbd, ThreadChip, Tint, shortcutLabel, useKitMotion, useLiveThread } from "../../kit";
import type { Comment, Severity } from "../../server/contract";
import { PENDING_AT } from "../data";
import { SEVERITY_HUE, SEVERITY_LABEL, awaitingAck, relativeTime } from "../model/comments";
import { SEVERITIES } from "../../server/shared";

/** "Sent to <thread>", with the title fetched when the thread is not live (archived). */
export function SentTo({ threadId, className }: { threadId: string; className?: string }) {
  const live = useLiveThread(threadId);
  const sdk = useSdk();
  const [title, setTitle] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (live !== null || title !== undefined) return;
    let cancelled = false;
    sdk.threads
      .get({ threadId })
      .then((thread) => !cancelled && setTitle(thread.title ?? thread.titleFallback ?? undefined))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [live, sdk, threadId, title]);
  return (
    <ThreadChip
      threadId={threadId}
      prefix="Sent to"
      className={cn("min-w-0", className)}
      {...(live === null && title !== undefined ? { title } : {})}
    />
  );
}

export interface NoteActions {
  onActivate: () => void;
  onReply: (body: string) => Promise<unknown>;
  onResolve: () => void;
  onReopen: () => void;
  /** The reviewer has seen an agent's resolution. */
  onAcknowledge: () => void;
  onDelete: () => void;
  onEdit: (patch: { body?: string; severity?: Severity }) => Promise<unknown>;
}

const EDGE: Record<Severity, string> = {
  note: "before:bg-muted-foreground/60",
  suggestion: "before:bg-sky-500",
  issue: "before:bg-attention",
  blocker: "before:bg-destructive",
};

export function SeverityTint({ severity }: { severity: Severity }) {
  const hue = SEVERITY_HUE[severity];
  return hue === null ? null : <Tint hue={hue}>{SEVERITY_LABEL[severity]}</Tint>;
}

function Meta({ children }: { children: ReactNode }) {
  return <span className="text-xs text-muted-foreground tabular-nums">{children}</span>;
}

function when(at: number, now: number) {
  return at === PENDING_AT ? "sending" : relativeTime(at, now);
}

/** Text area that grows, submits on mod+Enter, cancels on Escape. */
export function NoteField({
  initial = "",
  placeholder,
  submitLabel,
  onSubmit,
  onCancel,
  autoFocus = true,
  children,
}: {
  initial?: string;
  placeholder: string;
  submitLabel: string;
  onSubmit: (body: string) => Promise<unknown> | void;
  onCancel: () => void;
  autoFocus?: boolean;
  children?: ReactNode;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!autoFocus) return;
    const element = field.current;
    if (element === null) return;
    element.focus({ preventScroll: true });
    element.setSelectionRange(element.value.length, element.value.length);
  }, [autoFocus]);

  useEffect(() => {
    const element = field.current;
    if (element === null) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 240)}px`;
  }, [value]);

  const submit = () => {
    const body = value.trim();
    if (body === "") return;
    // Optimistic: clear at once; put the text back if the write fails.
    setValue("");
    setError(null);
    Promise.resolve(onSubmit(body)).catch((cause: unknown) => {
      setValue(body);
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    }
  };

  return (
    <div className="space-y-2">
      <textarea
        ref={field}
        value={value}
        rows={2}
        placeholder={placeholder}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={onKeyDown}
        className="block w-full resize-none rounded-md border border-border bg-background px-2.5 py-1.5 text-sm leading-6 text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      {error === null ? null : <p className="text-xs text-destructive-text">{error}</p>}
      {children === undefined ? null : <div>{children}</div>}
      <div className="flex items-center gap-2">
        <span className="flex-1" />
        <Button type="button" size="sm" variant="ghost" className="h-7 px-2" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" size="sm" className="h-7 gap-1.5 px-2.5" disabled={value.trim() === ""} onClick={submit}>
          {submitLabel}
          <span className="text-[11px] opacity-70">{shortcutLabel("mod+Enter")}</span>
        </Button>
      </div>
    </div>
  );
}

export function SeverityPicker({ value, onChange }: { value: Severity; onChange: (severity: Severity) => void }) {
  return (
    <div role="radiogroup" aria-label="Severity" className="flex items-center gap-1">
      {SEVERITIES.map((severity) => {
        const selected = severity === value;
        const hue = SEVERITY_HUE[severity];
        return (
          <button
            key={severity}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(severity)}
            className={cn(
              "h-6 rounded-md px-1.5 text-xs transition-colors duration-[120ms] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              selected
                ? hue === null
                  ? "bg-muted text-foreground"
                  : cn(
                      {
                        sky: "bg-sky-500/15 text-sky-700 in-[.dark]:bg-sky-400/15 in-[.dark]:text-sky-300",
                        amber: "bg-amber-500/15 text-amber-700 in-[.dark]:bg-amber-400/15 in-[.dark]:text-amber-300",
                        red: "bg-red-500/15 text-red-700 in-[.dark]:bg-red-400/15 in-[.dark]:text-red-300",
                      }[hue as "sky" | "amber" | "red"],
                    )
                : "text-muted-foreground hover:bg-state-hover hover:text-foreground",
            )}
          >
            {SEVERITY_LABEL[severity]}
          </button>
        );
      })}
    </div>
  );
}

export const CommentNote = forwardRef<
  HTMLDivElement,
  {
    comment: Comment;
    active: boolean;
    now: number;
    replying: boolean;
    setReplying: (replying: boolean) => void;
    actions: NoteActions;
    className?: string;
  }
>(function CommentNote({ comment, active, now, replying, setReplying, actions, className }, ref) {
  const { variants, transition } = useKitMotion();
  const [editing, setEditing] = useState(false);
  const [resolvedOpen, setResolvedOpen] = useState(false);
  const byAgent = awaitingAck(comment);
  // An agent's resolution stays open in full until the reviewer acknowledges it.
  const resolved = comment.state === "resolved" && !byAgent;
  const outdated = comment.state === "outdated";
  const pending = comment.createdAt === PENDING_AT;
  const expanded = !resolved || resolvedOpen || active;

  return (
    <div
      ref={ref}
      data-comment-id={comment.id}
      onMouseDown={(event) => {
        if ((event.target as HTMLElement).closest("button, textarea, a")) return;
        actions.onActivate();
      }}
      className={cn(
        "relative rounded-lg border bg-card px-3 py-2.5 text-sm transition-[border-color,opacity] duration-[120ms]",
        "before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:opacity-0 before:transition-opacity before:duration-[120ms]",
        byAgent ? "before:bg-success" : EDGE[comment.severity],
        active || byAgent ? "border-border before:opacity-100" : "border-border/60 hover:border-border",
        resolved && !active && "opacity-80",
        pending && "opacity-70",
        className,
      )}
    >
      <div className="flex min-h-6 items-center gap-1.5">
        {byAgent ? (
          <Tint hue="emerald">Resolved by agent</Tint>
        ) : outdated ? (
          <Tint hue="gray">Outdated</Tint>
        ) : (
          <SeverityTint severity={comment.severity} />
        )}
        {byAgent ? (
          <Meta>{when(comment.resolvedAt ?? comment.updatedAt, now)}</Meta>
        ) : resolved ? (
          <button
            type="button"
            onClick={() => setResolvedOpen((open) => !open)}
            className="rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            aria-expanded={expanded}
          >
            Resolved{comment.resolvedBy === "agent" ? " by agent" : ""}
          </button>
        ) : comment.sentThreadId !== null ? (
          <SentTo threadId={comment.sentThreadId} />
        ) : (
          <Meta>{when(comment.createdAt, now)}</Meta>
        )}
        <span className="flex-1" />
        {active && !editing && !resolved && !byAgent ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-xs text-muted-foreground"
            onClick={() => setEditing(true)}
          >
            Edit
          </Button>
        ) : null}
      </div>

      {resolved && !expanded ? (
        <p className="mt-0.5 truncate text-sm text-muted-foreground">{comment.body}</p>
      ) : null}

      <Collapse open={expanded}>
        {outdated && comment.snippet !== "" ? (
          <pre className="mt-1.5 max-h-24 overflow-hidden rounded-md bg-muted/60 px-2 py-1 font-mono text-xs leading-5 text-muted-foreground line-through decoration-muted-foreground/40">
            {comment.snippet.split("\n").slice(0, 4).join("\n")}
          </pre>
        ) : null}
        {editing ? (
          <div className="mt-1.5">
            <EditField comment={comment} onDone={() => setEditing(false)} onEdit={actions.onEdit} />
          </div>
        ) : (
          <p className="mt-1 max-w-[72ch] whitespace-pre-wrap break-words text-sm leading-6 text-foreground">{comment.body}</p>
        )}

        {comment.replies.length > 0 ? (
          <ul className="mt-2 space-y-2 border-l border-border/70 pl-2.5">
            <AnimatePresence initial={false}>
              {comment.replies.map((reply) => (
                <motion.li
                  key={reply.id}
                  layout="position"
                  variants={variants.listItem}
                  initial="hidden"
                  animate="visible"
                  exit="exit"
                  transition={transition("enter")}
                  className="text-sm"
                >
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-medium text-foreground">{reply.author === "agent" ? "Agent" : "You"}</span>
                    <Meta>{when(reply.createdAt, now)}</Meta>
                  </div>
                  <p className="whitespace-pre-wrap break-words leading-6 text-foreground">{reply.body}</p>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        ) : null}

        {replying ? (
          <div className="mt-2">
            <NoteField
              placeholder="Reply"
              submitLabel="Reply"
              onSubmit={async (body) => {
                setReplying(false);
                await actions.onReply(body);
              }}
              onCancel={() => setReplying(false)}
            />
          </div>
        ) : byAgent ? (
          <div className="mt-2 flex items-center gap-1">
            <Button type="button" variant="ghost" size="sm" className="h-7 gap-1.5 px-2" onClick={actions.onAcknowledge}>
              Acknowledge <Kbd>X</Kbd>
            </Button>
            <Button type="button" variant="ghost" size="sm" className="h-7 px-2" onClick={actions.onReopen}>
              Reopen
            </Button>
          </div>
        ) : active && !editing ? (
          <div className="mt-2 flex items-center gap-1">
            <Button type="button" variant="ghost" size="sm" className="h-7 gap-1.5 px-2" onClick={() => setReplying(true)}>
              Reply <Kbd>R</Kbd>
            </Button>
            {resolved ? (
              <Button type="button" variant="ghost" size="sm" className="h-7 gap-1.5 px-2" onClick={actions.onReopen}>
                Reopen <Kbd>X</Kbd>
              </Button>
            ) : (
              <Button type="button" variant="ghost" size="sm" className="h-7 gap-1.5 px-2" onClick={actions.onResolve}>
                Mark resolved <Kbd>X</Kbd>
              </Button>
            )}
            <span className="flex-1" />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="size-7 p-0 text-muted-foreground hover:text-destructive-text"
              onClick={actions.onDelete}
              aria-label="Delete comment"
            >
              <Icon name="Trash2" className="size-3.5" />
            </Button>
          </div>
        ) : null}
      </Collapse>
    </div>
  );
});

function EditField({
  comment,
  onDone,
  onEdit,
}: {
  comment: Comment;
  onDone: () => void;
  onEdit: NoteActions["onEdit"];
}) {
  const [severity, setSeverity] = useState<Severity>(comment.severity);
  return (
    <NoteField
      initial={comment.body}
      placeholder="Comment"
      submitLabel="Save"
      onSubmit={async (body) => {
        onDone();
        await onEdit({ body, severity });
      }}
      onCancel={onDone}
    >
      <SeverityPicker value={severity} onChange={setSeverity} />
    </NoteField>
  );
}

/** A new comment being written on a selected range. */
export const DraftNote = forwardRef<
  HTMLDivElement,
  {
    startLine: number;
    endLine: number;
    onSubmit: (body: string, severity: Severity) => Promise<unknown> | void;
    onCancel: () => void;
    className?: string;
  }
>(function DraftNote({ startLine, endLine, onSubmit, onCancel, className }, ref) {
  const [severity, setSeverity] = useState<Severity>("note");
  return (
    <div ref={ref} data-comment-id="draft" className={cn("rounded-lg border border-border bg-card px-3 py-2.5", className)}>
      <p className="mb-1.5 text-xs text-muted-foreground tabular-nums">
        {startLine === endLine ? `Line ${startLine}` : `Lines ${startLine}-${endLine}`}
      </p>
      <NoteField
        placeholder="Comment on this code"
        submitLabel="Comment"
        onSubmit={(body) => onSubmit(body, severity)}
        onCancel={onCancel}
      >
        <SeverityPicker value={severity} onChange={setSeverity} />
      </NoteField>
    </div>
  );
});
