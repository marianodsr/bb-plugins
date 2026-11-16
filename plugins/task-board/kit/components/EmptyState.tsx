// GENERATED from /kit by kit/scripts/sync.mjs (kit 36f976388355). Do not edit; change /kit and re-sync.
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { Icon } from "../../components/ui/icon";

/**
 * What this is and the one action to take. `tone="error"` says what failed
 * and how to fix it (no apology).
 *
 * ```tsx
 * <EmptyState icon="MessageSquare" title="No comments yet"
 *   description="Select lines in the editor and press C to comment."
 *   action={<Button size="sm" onClick={startComment}>Comment</Button>} />
 * ```
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  tone = "neutral",
  className,
}: {
  /** A bb icon name, e.g. "MessageSquare". */
  icon?: string;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  tone?: "neutral" | "error";
  className?: string;
}) {
  return (
    <div
      role={tone === "error" ? "alert" : undefined}
      className={cn("flex w-full flex-col items-start gap-3 px-4 py-8", className)}
    >
      <div className="mx-auto flex w-full max-w-[44ch] flex-col items-start gap-1.5">
        {icon ? (
          <span
            className={cn(
              "mb-1.5 inline-flex size-8 items-center justify-center rounded-lg bg-muted",
              tone === "error" ? "text-destructive-text" : "text-muted-foreground",
            )}
          >
            <Icon name={icon} className="size-4" aria-hidden />
          </span>
        ) : null}
        <p className="text-sm font-medium text-foreground">{title}</p>
        {description ? (
          <div className="text-sm leading-6 text-muted-foreground">{description}</div>
        ) : null}
        {action ? <div className="mt-2.5 flex flex-wrap items-center gap-2">{action}</div> : null}
      </div>
    </div>
  );
}
