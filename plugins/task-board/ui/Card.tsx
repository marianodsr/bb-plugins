import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { StatusDot, Tint, hueFor, runStatusLabel } from "../kit";
import { cn } from "../lib/utils";
import type { TaskCard } from "../src/schemas";
import { JiraChip } from "./JiraChip";
import { summaryState, useThreadViews } from "./threads";

const PRIORITY_TEXT: Record<TaskCard["priority"], string | null> = {
  none: null,
  low: "Low",
  medium: "Medium",
  high: "High",
  urgent: "Urgent",
};

export function PriorityText({ priority, className }: { priority: TaskCard["priority"]; className?: string }) {
  const text = PRIORITY_TEXT[priority];
  if (!text) return null;
  return (
    <span
      className={cn(
        "text-xs",
        priority === "urgent"
          ? "font-medium text-destructive-text"
          : priority === "high"
            ? "text-warning-text"
            : "text-muted-foreground",
        className,
      )}
    >
      {text}
    </span>
  );
}

/** The thread line on a card: one thread by title, several by count. */
function ThreadLine({ task }: { task: TaskCard }) {
  const views = useThreadViews(task.threadIds);
  const state = summaryState(views);
  if (!state) return null;
  const single = views.length === 1 ? views[0]! : null;
  const label = single?.label ?? runStatusLabel(state);
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <StatusDot status={state} label={label} />
      <span className="truncate">
        {single ? single.title : `${views.length} threads`}
      </span>
    </span>
  );
}

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  task: TaskCard;
  /** Shown before the title in the all-projects view. */
  projectName?: string;
  selected?: boolean;
  /** Keyboard pick-up or pointer drag in progress on this card. */
  lifted?: boolean;
  /** The empty slot a dragged card will drop into. */
  placeholder?: boolean;
  trailing?: ReactNode;
}

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { task, projectName, selected, lifted, placeholder, className, trailing, ...rest },
  ref,
) {
  const views = useThreadViews(task.threadIds);
  const running = views.some((view) => view.state === "running");
  const hasMeta =
    task.labels.length > 0 || task.externalRef !== null || task.priority !== "none" || task.commentCount > 0;

  return (
    <div
      ref={ref}
      data-card-id={task.id}
      aria-selected={selected || undefined}
      className={cn(
        "group/card relative flex w-full flex-col gap-2 rounded-lg border bg-card px-3 py-2.5 text-left outline-none",
        "border-border/70 transition-[background-color,border-color,box-shadow] duration-[120ms] ease-out",
        "hover:border-border focus-visible:ring-2 focus-visible:ring-ring",
        selected && "border-border bg-surface-selected/70",
        lifted && "border-border shadow-lg",
        placeholder && "border-dashed border-border bg-muted/40 shadow-none",
        className,
      )}
      {...rest}
    >
      {running && !placeholder ? (
        <span
          aria-hidden
          className="kit-live-line pointer-events-none absolute inset-y-2 left-0 w-0.5 -translate-x-px rounded-full bg-success"
        />
      ) : null}
      <div className={cn("flex flex-col gap-2", placeholder && "invisible")}>
        {projectName ? <span className="text-xs text-muted-foreground">{projectName}</span> : null}
        <div className="flex items-start gap-2">
          <span className="line-clamp-3 min-w-0 flex-1 text-sm font-medium leading-5 text-foreground [overflow-wrap:anywhere]">
            {task.title}
          </span>
          {trailing}
        </div>
        {hasMeta ? (
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
            {task.labels.map((label) => (
              <Tint key={label} hue={hueFor(label)}>
                {label}
              </Tint>
            ))}
            {task.externalRef ? <JiraChip externalRef={task.externalRef} compact /> : null}
            <PriorityText priority={task.priority} />
            {task.commentCount > 0 ? (
              <span className="text-xs tabular-nums text-muted-foreground">
                {task.commentCount} {task.commentCount === 1 ? "comment" : "comments"}
              </span>
            ) : null}
          </div>
        ) : null}
        <ThreadLine task={task} />
      </div>
    </div>
  );
});
