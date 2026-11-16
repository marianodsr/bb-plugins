// GENERATED from /kit by kit/scripts/sync.mjs (kit 36f976388355). Do not edit; change /kit and re-sync.
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { cn } from "../../lib/utils";

export type RunStatus = "idle" | "running" | "waiting" | "failed";

const LABELS: Record<RunStatus, string> = {
  idle: "Idle",
  running: "Running",
  waiting: "Needs you",
  failed: "Failed",
};

/**
 * A thread or job's live state. Shape as well as colour carries it: idle is
 * a hollow ring, running pulses, waiting and failed are solid.
 *
 * ```tsx
 * <StatusDot status="running" />
 * <StatusDot status={threadRunStatus(thread)} label={thread.indicatorLabel ?? undefined} />
 * ```
 */
export function StatusDot({
  status,
  label,
  size = "sm",
  className,
}: {
  status: RunStatus;
  /** Accessible name; defaults to the status name. */
  label?: string;
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <span
      role="img"
      aria-label={label ?? LABELS[status]}
      title={label ?? LABELS[status]}
      data-status={status}
      className={cn(
        "inline-block shrink-0 rounded-full",
        size === "sm" ? "size-2" : "size-2.5",
        status === "idle" && "border-[1.5px] border-muted-foreground/55",
        status === "running" && "kit-live-pulse bg-success text-success",
        status === "waiting" && "bg-attention",
        status === "failed" && "bg-destructive",
        className,
      )}
    />
  );
}

export function runStatusLabel(status: RunStatus): string {
  return LABELS[status];
}

/** Map bb's live thread fields onto the four kit states. */
export function threadRunStatus(
  thread: Pick<
    PluginSidebarThread,
    "status" | "runtimeStatus" | "hasPendingInteraction" | "indicator" | "queuedWork"
  >,
): RunStatus {
  if (thread.hasPendingInteraction || thread.indicator === "waiting-for-input") return "waiting";
  const status = String(thread.status);
  if (
    status === "error" ||
    status === "failed" ||
    thread.indicator === "unread-error" ||
    thread.queuedWork === "failed"
  )
    return "failed";
  if (
    status === "pending" ||
    status === "starting" ||
    status === "active" ||
    status === "stopping" ||
    thread.runtimeStatus === "provisioning" ||
    thread.indicator === "runtime" ||
    thread.indicator === "workflow" ||
    thread.indicator === "background-agent" ||
    thread.indicator === "background-command"
  )
    return "running";
  return "idle";
}
