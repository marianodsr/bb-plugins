// GENERATED from /kit by kit/scripts/sync.mjs (kit 36f976388355). Do not edit; change /kit and re-sync.
import type { MouseEvent } from "react";
import {
  experimental_useSidebarThreads as useSidebarThreads,
  useBbNavigate,
} from "@get-bb/plugin-sdk/app";
import { cn } from "../../lib/utils";
import { StatusDot, threadRunStatus, type RunStatus } from "./StatusDot";

/**
 * A thread's title and live status; activating it opens the thread.
 * Live data comes from bb's sidebar view; `title` and `status` override it
 * (useful for fixtures, or a thread that is not in the live view yet).
 *
 * ```tsx
 * <ThreadChip threadId={comment.sentThreadId} />
 * <ThreadChip threadId="thr_1" title="Fix session refresh" status="running" />
 * ```
 */
export function ThreadChip({
  threadId,
  title,
  status,
  prefix,
  className,
  onOpen,
}: {
  threadId: string;
  title?: string;
  status?: RunStatus;
  /** Text before the title, e.g. "Sent to". Rendered muted. */
  prefix?: string;
  className?: string;
  /** Replaces the default `navigate.toThread(threadId)`. */
  onOpen?: () => void;
}) {
  const navigate = useBbNavigate();
  const live = useLiveThread(threadId);
  const name = title ?? live?.displayTitle ?? "Thread";
  const run: RunStatus = status ?? (live ? threadRunStatus(live) : "idle");
  const href = live?.href;

  const open = (event: MouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    if (onOpen) onOpen();
    else navigate.toThread(threadId);
  };

  return (
    <a
      href={href ?? "#"}
      onClick={open}
      data-kit-thread-chip={threadId}
      title={prefix ? `${prefix} ${name}` : name}
      className={cn(
        "group/chip relative inline-flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-md border border-border/70 bg-background px-2",
        // 44 px touch target without changing the layout.
        "pointer-coarse:after:absolute pointer-coarse:after:inset-x-0 pointer-coarse:after:-inset-y-2 pointer-coarse:after:content-['']",
        "text-xs text-foreground no-underline transition-colors duration-[120ms] ease-out hover:bg-state-hover",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      <StatusDot status={run} label={live?.indicatorLabel ?? undefined} />
      {prefix ? <span className="shrink-0 text-muted-foreground">{prefix}</span> : null}
      <span className="min-w-0 truncate font-medium">{name}</span>
    </a>
  );
}

/** One thread from bb's live sidebar view, or null when it is not there. */
export function useLiveThread(threadId: string | null | undefined) {
  const { threads } = useSidebarThreads();
  if (!threadId) return null;
  return threads.find((t) => t.id === threadId) ?? null;
}
