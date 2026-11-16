// Small shared pieces: status tint, issue rows, section headings.
import { forwardRef, type ReactNode } from "react";
import { cn } from "../lib/utils";
import { Tint, type TintHue } from "../kit";
import type { IssueRef, IssueRow, StatusCategory } from "../src/schemas";
import { shortAge, shortName } from "./logic";

export const CATEGORY_HUE: Record<StatusCategory, TintHue> = {
  todo: "gray",
  in_progress: "blue",
  done: "green",
};

export function StatusTint({
  status,
  category,
  className,
}: {
  status: string;
  category: StatusCategory | null;
  className?: string;
}) {
  return (
    <Tint hue={category ? CATEGORY_HUE[category] : "gray"} className={cn("shrink-0", className)} title={status}>
      {status}
    </Tint>
  );
}

/** An issue key as content: UI font, tabular figures. */
export function IssueKey({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("shrink-0 tabular-nums text-muted-foreground", className)}>{children}</span>;
}

export function Unassigned() {
  return (
    <span className="text-subtle-foreground" aria-label="Unassigned" title="Unassigned">
      –
    </span>
  );
}

/**
 * One 32 px list row. Wide containers add the status and age columns
 * (`@md` on the list's container).
 */
export const IssueRowView = forwardRef<
  HTMLButtonElement,
  {
    issue: IssueRow;
    now: number;
    selected: boolean;
    open: boolean;
    flash: boolean;
    onSelect: () => void;
    onOpen: () => void;
  }
>(function IssueRowView({ issue, now, selected, open, flash, onSelect, onOpen }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      role="option"
      aria-selected={selected}
      aria-current={open ? "true" : undefined}
      data-issue-key={issue.key}
      tabIndex={selected ? 0 : -1}
      onFocus={onSelect}
      onClick={onOpen}
      className={cn(
        "group/row relative flex h-8 w-full min-w-0 items-center gap-3 rounded-lg px-3 text-left text-sm",
        "outline-none transition-colors duration-[120ms] ease-out hover:bg-state-hover",
        "focus-visible:ring-1 focus-visible:ring-ring",
        selected && "bg-surface-selected hover:bg-surface-selected",
        flash && "kit-flash",
      )}
    >
      {open ? <span aria-hidden className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-foreground/70" /> : null}
      <IssueKey className="w-[4.75rem] text-xs">{issue.key}</IssueKey>
      <span className="min-w-0 flex-1 truncate text-foreground">{issue.summary || "Untitled"}</span>
      <StatusTint
        status={issue.status}
        category={issue.statusCategory}
        className="hidden max-w-[9rem] truncate @2xl:inline-flex"
      />
      <span className="w-14 shrink-0 truncate text-right text-xs text-muted-foreground">
        {issue.assignee ? shortName(issue.assignee.displayName) : <Unassigned />}
      </span>
      <span className="hidden w-8 shrink-0 text-right text-xs tabular-nums text-subtle-foreground @md:inline">
        {shortAge(issue.updated, now)}
      </span>
    </button>
  );
});

/** A related issue (subtask, link target): compact row that opens it. */
export function RefRow({ issue, label, onOpen }: { issue: IssueRef; label?: string; onOpen: (key: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(issue.key)}
      className={cn(
        "flex h-8 w-full min-w-0 items-center gap-3 rounded-lg px-2 text-left text-sm outline-none",
        "transition-colors duration-[120ms] ease-out hover:bg-state-hover focus-visible:ring-1 focus-visible:ring-ring",
      )}
    >
      {label ? <span className="w-24 shrink-0 truncate text-xs text-muted-foreground">{label}</span> : null}
      <IssueKey className="text-xs">{issue.key}</IssueKey>
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          issue.statusCategory === "done" ? "text-muted-foreground line-through decoration-muted-foreground/40" : "text-foreground",
        )}
      >
        {issue.summary || "Untitled"}
      </span>
      {issue.status ? <StatusTint status={issue.status} category={issue.statusCategory} className="max-w-[8rem] truncate" /> : null}
    </button>
  );
}

/** Section heading inside the issue document: title, quiet count. */
export function SectionHeading({ children, count }: { children: ReactNode; count?: ReactNode }) {
  return (
    <h2 className="flex items-baseline gap-2 text-sm font-medium text-foreground">
      {children}
      {count !== undefined ? <span className="text-xs font-normal tabular-nums text-muted-foreground">{count}</span> : null}
    </h2>
  );
}

