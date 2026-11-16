// List view: the same tasks as dense rows grouped by lane. Rows share the
// cards' layoutId, so switching views morphs each card into its row.
import { useMemo, useRef, useState } from "react";
import { LayoutGroup, motion } from "motion/react";
import { StatusDot, Tint, hueFor, useHotkeys, useKitMotion } from "../kit";
import { cn } from "../lib/utils";
import type { TaskCard } from "../src/schemas";
import { PriorityText } from "./Card";
import { JiraChip } from "./JiraChip";
import type { Column } from "./model";
import { summaryState, useThreadViews } from "./threads";
import { requestStartWork } from "./detail-bus";

export function relativeTime(ms: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function Row({
  task,
  projectName,
  selected,
  focused,
  onOpen,
  onFocus,
  rowRef,
}: {
  task: TaskCard;
  projectName?: string;
  selected: boolean;
  focused: boolean;
  onOpen: () => void;
  onFocus: () => void;
  rowRef: (el: HTMLDivElement | null) => void;
}) {
  const views = useThreadViews(task.threadIds);
  const state = summaryState(views);
  const running = views.some((view) => view.state === "running");
  return (
    <div
      ref={rowRef}
      role="listitem"
      tabIndex={focused ? 0 : -1}
      aria-selected={selected || undefined}
      aria-label={task.title}
      onClick={onOpen}
      onFocus={onFocus}
      className={cn(
        "relative flex h-8 cursor-pointer items-center gap-3 rounded-lg border border-transparent px-2.5 text-sm outline-none",
        "transition-colors duration-[120ms] ease-out hover:bg-state-hover focus-visible:ring-2 focus-visible:ring-ring",
        selected && "bg-surface-selected",
      )}
    >
      {running ? (
        <span aria-hidden className="kit-live-line absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-success" />
      ) : null}
      <span className="w-4 shrink-0">{state ? <StatusDot status={state} /> : null}</span>
      {projectName ? <span className="hidden w-28 shrink-0 truncate text-xs text-muted-foreground @xl:block">{projectName}</span> : null}
      <span className="min-w-0 flex-1 truncate font-medium text-foreground">{task.title}</span>
      <span className="hidden items-center gap-1.5 @lg:flex">
        {task.labels.slice(0, 2).map((label) => (
          <Tint key={label} hue={hueFor(label)}>
            {label}
          </Tint>
        ))}
      </span>
      {task.externalRef ? (
        <span className="hidden @md:inline-flex">
          <JiraChip externalRef={task.externalRef} compact />
        </span>
      ) : null}
      <PriorityText priority={task.priority} className="hidden w-14 shrink-0 @md:inline" />
      <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground" title={new Date(task.updatedAt).toLocaleString()}>
        {relativeTime(task.updatedAt)}
      </span>
    </div>
  );
}

export function ListView({
  columns,
  selectedId,
  onOpen,
  projectNames,
}: {
  columns: Column[];
  selectedId: string | null;
  onOpen: (task: TaskCard) => void;
  projectNames: Map<string, string> | null;
}) {
  const { reduced, transition } = useKitMotion();
  const container = useRef<HTMLDivElement>(null);
  const rows = useRef(new Map<string, HTMLDivElement>());
  const flat = useMemo(() => columns.flatMap((column) => column.tasks), [columns]);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const tabStop = focusedId && flat.some((task) => task.id === focusedId) ? focusedId : flat[0]?.id ?? null;

  const step = (delta: number) => {
    const index = flat.findIndex((task) => task.id === tabStop);
    const next = flat[Math.max(0, Math.min(flat.length - 1, index + delta))];
    if (!next) return;
    setFocusedId(next.id);
    rows.current.get(next.id)?.focus();
  };

  useHotkeys(
    [
      { key: ["j", "ArrowDown"], handler: () => step(1), description: "Next task", group: "List" },
      { key: ["k", "ArrowUp"], handler: () => step(-1), description: "Previous task", group: "List" },
      {
        key: "Enter",
        handler: () => {
          const task = flat.find((row) => row.id === tabStop);
          if (task) onOpen(task);
        },
        description: "Open the task",
        group: "List",
      },
      {
        key: "s",
        handler: () => {
          const task = flat.find((row) => row.id === tabStop);
          if (task) requestStartWork(task, onOpen);
        },
        description: "Start work on the task",
        group: "List",
      },
    ],
    { scope: container },
  );

  return (
    <LayoutGroup id="task-board">
      <div ref={container} className="@container min-h-0 flex-1 overflow-auto px-4 pb-6 pt-2 md:px-5">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-5">
          {columns.map((column) => (
            <section key={column.id} aria-label={column.name}>
              <h2 className="flex h-8 items-center gap-2 px-2.5 text-sm font-medium text-foreground">
                {column.name}
                <span className="text-xs font-normal tabular-nums text-muted-foreground">{column.total}</span>
              </h2>
              <div role="list" className="flex flex-col">
                {column.tasks.length === 0 ? (
                  <p className="h-8 px-2.5 text-xs leading-8 text-muted-foreground">No tasks</p>
                ) : null}
                {column.tasks.map((task) => (
                  <motion.div
                    key={task.id}
                    layout={reduced ? false : "position"}
                    layoutId={reduced ? undefined : `card-${task.id}`}
                    transition={transition("shift")}
                  >
                    <Row
                      task={task}
                      projectName={projectNames?.get(task.projectId)}
                      selected={selectedId === task.id}
                      focused={task.id === tabStop}
                      onOpen={() => onOpen(task)}
                      onFocus={() => setFocusedId(task.id)}
                      rowRef={(el) => {
                        if (el) rows.current.set(task.id, el);
                        else rows.current.delete(task.id);
                      }}
                    />
                  </motion.div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </LayoutGroup>
  );
}
