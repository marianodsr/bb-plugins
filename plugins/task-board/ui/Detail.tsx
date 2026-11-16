// The task's detail, in the board page's side panel: the task as a document,
// edited in place, its linked threads with the live chat beneath, and its
// activity. "Start work" hands it to a thread through the kit.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import * as Popover from "@radix-ui/react-popover";
import {
  Markdown,
  ThreadChat,
  experimental_useRpcMutation,
  experimental_useTabVisible,
  useRpc,
  type JsonValue,
} from "@get-bb/plugin-sdk/app";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import {
  EmptyState,
  HandoffSheet,
  InlineComposer,
  Kbd,
  SentChip,
  Skeleton,
  ThreadChip,
  Tint,
  hueFor,
  shortcutLabel,
  useHandoff,
  useHotkeys,
  useKitMotion,
  type RunStatus,
} from "../kit";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "../components/ui/dialog";
import { Icon } from "../components/ui/icon";
import { usePortalScopeProps } from "../lib/portal-scope";
import { cn } from "../lib/utils";
import { rpcContract } from "../src/contract";
import { buildTaskPrompt } from "../src/prompt";
import { PRIORITIES, type Priority, type TaskDetail, type TaskEvent } from "../src/schemas";
import { PriorityText } from "./Card";
import { failureText, useBoard, useTask } from "./data";
import { clearPendingStart, setShownTask, usePendingStart } from "./detail-bus";
import { JiraChip } from "./JiraChip";
import { relativeTime } from "./ListView";
import { taskIdFromParams } from "./tabs";
import { ThreadStatusProvider, useThreadView, type ThreadView } from "./threads";

const PRIORITY_NAMES: Record<Priority, string> = {
  none: "No priority",
  low: "Low",
  medium: "Medium",
  high: "High",
  urgent: "Urgent",
};

function taskInput(taskId: string) {
  return { taskId, eventLimit: 50 };
}

/** Times for predicted comments, recorded once before the write. */
const commentAt = new Map<string, number>();

function useTaskWrites(taskId: string) {
  const input = taskInput(taskId);
  const update = experimental_useRpcMutation({
    contract: rpcContract,
    method: "updateTask",
    optimistic(write, cache) {
      cache.update("task", input, (current) =>
        current.task
          ? {
              task: {
                ...current.task,
                ...(write.title !== undefined ? { title: write.title } : {}),
                ...(write.body !== undefined ? { body: write.body } : {}),
                ...(write.priority !== undefined ? { priority: write.priority } : {}),
                ...(write.labels !== undefined ? { labels: write.labels } : {}),
              },
            }
          : current,
      );
    },
  });
  const move = experimental_useRpcMutation({
    contract: rpcContract,
    method: "moveTask",
    optimistic(write, cache) {
      cache.update("task", input, (current) => (current.task ? { task: { ...current.task, laneId: write.laneId } } : current));
    },
  });
  const comment = experimental_useRpcMutation({
    contract: rpcContract,
    method: "addComment",
    optimistic(write, cache) {
      cache.update("task", input, (current) => {
        if (!current.task) return current;
        const predicted: TaskEvent = {
          id: -1,
          taskId: write.taskId,
          actor: "user",
          actorThreadId: null,
          kind: "commented",
          payload: { body: write.body },
          createdAt: commentAt.get(write.body) ?? 0,
        };
        return {
          task: { ...current.task, events: [predicted, ...current.task.events], commentCount: current.task.commentCount + 1 },
        };
      });
    },
  });
  const archive = experimental_useRpcMutation({ contract: rpcContract, method: "archiveTask" });
  const remove = experimental_useRpcMutation({ contract: rpcContract, method: "deleteTask" });
  const startWork = experimental_useRpcMutation({ contract: rpcContract, method: "startWork" });
  const unlink = experimental_useRpcMutation({ contract: rpcContract, method: "unlinkThread" });
  return {
    update: (patch: Omit<Parameters<typeof update.mutate>[0], "taskId">) =>
      update.mutate({ taskId, ...patch }).catch((error) => {
        toast.error(failureText("Could not save the task", error));
        throw error;
      }),
    move: (laneId: string) =>
      move.mutate({ taskId, laneId, placement: "top" }).catch((error) => toast.error(failureText("Could not move the task", error))),
    comment: (body: string) => {
      commentAt.set(body, Date.now());
      return comment.mutate({ taskId, body });
    },
    archive: archive.mutate,
    remove: remove.mutate,
    startWork: startWork.mutate,
    unlink: unlink.mutate,
  };
}

// ---------------------------------------------------------------------------

export function TaskPanel({ params }: { params: JsonValue | null }) {
  const visible = experimental_useTabVisible();
  return <TaskView taskId={taskIdFromParams(params)} active={visible} />;
}

/** One task's document; used by the side-panel tab and the compact sheet. */
export function TaskView({ taskId, active, autoFocus = false }: { taskId: string | null; active: boolean; autoFocus?: boolean }) {
  useEffect(() => {
    setShownTask(taskId);
    return () => setShownTask(null);
  }, [taskId]);
  const query = useTask(taskId);

  if (!taskId) {
    return (
      <div className="p-4">
        <EmptyState
          icon="ListTodo"
          title="No task open"
          description={
            <>
              Open a card to read it here. On the board, move with the arrow keys and press <Kbd>Enter</Kbd>.
            </>
          }
        />
      </div>
    );
  }
  if (query.isLoading || (!query.data && !query.error)) return <DetailSkeleton />;
  if (query.error && !query.data) {
    return (
      <div className="p-4">
        <EmptyState
          tone="error"
          icon="AlertCircle"
          title="Could not load the task"
          description={query.error.message}
          action={
            <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
              Try again
            </Button>
          }
        />
      </div>
    );
  }
  const task = query.data?.task ?? null;
  if (!task) {
    return (
      <div className="p-4">
        <EmptyState icon="Trash2" title="This task was deleted" description="Pick another card on the board." />
      </div>
    );
  }
  return (
    <ThreadStatusProvider threadIds={task.threads.map((link) => link.threadId)}>
      <TaskDocument key={task.id} task={task} active={active} autoFocus={autoFocus} />
    </ThreadStatusProvider>
  );
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-4 p-4 md:p-5">
      <Skeleton className="h-7 w-3/4" />
      <Skeleton className="h-5 w-1/2" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-8 w-40" />
    </div>
  );
}

function TaskDocument({ task, active, autoFocus }: { task: TaskDetail; active: boolean; autoFocus: boolean }) {
  const writes = useTaskWrites(task.id);
  const visible = active;
  const root = useRef<HTMLDivElement>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingBody, setEditingBody] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [chatThread, setChatThread] = useState<string | null>(null);
  const pendingStart = usePendingStart();
  const commentBox = useRef<HTMLDivElement>(null);

  const [landing, setLanding] = useState<string | null>(null);
  const handoff = useHandoff({
    items: [task],
    getKey: (item) => item.id,
    buildPrompt: ([item]) => buildTaskPrompt(item!),
    pluginMetadata: ([item], target) => {
      // The kit asks for metadata just before the packet sets off, with the
      // target thread. Show that thread's row in the panel now, so a packet
      // whose sidebar row is out of view lands on it instead of nowhere.
      if (target.kind !== "new") setLanding(target.threadId);
      return { taskId: item!.id };
    },
    noun: { one: "task", many: "tasks" },
    projectId: task.projectId,
    newThreadTitle: ([item]) => item!.title,
    onSent: async (result, [item]) => {
      setChatThread(result.threadId);
      try {
        await writes.startWork({ taskId: item!.id, threadId: result.threadId });
      } catch (error) {
        toast.error(failureText("The thread has the task, but the card could not be linked", error));
      }
    },
  });

  // The board's S key asks for this.
  useEffect(() => {
    if (pendingStart === task.id && visible) {
      clearPendingStart();
      handoff.setOpen(true);
    }
  }, [pendingStart, task.id, visible, handoff]);

  useHotkeys(
    [
      { key: "s", handler: () => handoff.setOpen(true), description: "Start work", group: "Task", enabled: visible },
      { key: "r", handler: () => setEditingTitle(true), description: "Rename the task", group: "Task", enabled: visible },
      { key: "e", handler: () => setEditingBody(true), description: "Edit the description", group: "Task", enabled: visible },
      {
        key: "c",
        handler: () => commentBox.current?.querySelector("textarea")?.focus(),
        description: "Comment",
        group: "Task",
        enabled: visible,
      },
    ],
    { scope: root },
  );

  // In the compact sheet the document takes focus, so its keys work at once.
  useEffect(() => {
    if (autoFocus) requestAnimationFrame(() => root.current?.focus({ preventScroll: true }));
  }, [autoFocus]);

  // The provisional row gives way once the link is in, or the send failed.
  const linkedIds = task.threads.map((link) => link.threadId).join(",");
  useEffect(() => {
    if (!landing) return;
    if (handoff.phase === "failed" || linkedIds.split(",").includes(landing)) {
      const timer = window.setTimeout(() => setLanding(null), 900);
      return () => window.clearTimeout(timer);
    }
  }, [landing, handoff.phase, linkedIds]);

  const threadIds = task.threads.map((link) => link.threadId);
  const shownChat = chatThread && threadIds.includes(chatThread) ? chatThread : threadIds.at(-1) ?? null;

  return (
    <div ref={root} tabIndex={-1} className="flex h-full min-h-0 flex-col overflow-y-auto outline-none">
      <article className="flex flex-col gap-5 px-4 pb-6 pt-4 md:px-5">
        <header ref={handoff.itemRef(task.id)} className="flex flex-col gap-3">
          {editingTitle ? (
            <InlineComposer
              aria-label="Task title"
              defaultValue={task.title}
              submitLabel="Save"
              onCancel={() => setEditingTitle(false)}
              onSubmit={async (title) => {
                setEditingTitle(false);
                if (title.trim() !== task.title) await writes.update({ title: title.trim() });
              }}
            />
          ) : (
            <h1 className="text-xl font-semibold tracking-tight text-foreground [overflow-wrap:anywhere]">
              <button
                type="button"
                onClick={() => setEditingTitle(true)}
                title={`Rename (${shortcutLabel("r")})`}
                className="rounded-md text-left outline-none hover:bg-state-hover focus-visible:ring-2 focus-visible:ring-ring"
              >
                {task.title}
              </button>
            </h1>
          )}
          <MetaRow task={task} writes={writes} />
          <div className="flex flex-wrap items-center gap-2">
            <HandoffSheet handoff={handoff} align="start" side="bottom">
              <Button size="sm" aria-keyshortcuts="s">
                Start work <Kbd className="ml-1 border-background/30 bg-background/15 text-background">S</Kbd>
              </Button>
            </HandoffSheet>
            <SentChip result={handoff.lastResult} />
          </div>
        </header>

        <Description task={task} editing={editingBody} setEditing={setEditingBody} writes={writes} />

        <ThreadsSection task={task} shownChat={shownChat} onPick={setChatThread} writes={writes} landing={landing} />

        <section aria-label="Activity" className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-foreground">Activity</h2>
          <div ref={commentBox}>
            <InlineComposer
              aria-label="Comment"
              placeholder="Leave a comment"
              submitLabel="Comment"
              multiline
              keepOpen
              autoFocus={false}
              onSubmit={(body) => writes.comment(body).then(() => undefined)}
            />
          </div>
          <ActivityList taskId={task.id} events={task.events} cursor={task.eventsCursor} />
        </section>

        <footer className="flex items-center gap-1 border-t border-border/60 pt-3">
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              writes.archive({ taskId: task.id, archived: task.archivedAt === null }).then(
                () => toast(task.archivedAt === null ? `Archived "${task.title}"` : `Restored "${task.title}"`),
                (error) => toast.error(failureText("Could not archive the task", error)),
              )
            }
          >
            {task.archivedAt === null ? "Archive" : "Restore"}
          </Button>
          <Button size="sm" variant="ghost" className="text-destructive-text" onClick={() => setConfirmDelete(true)}>
            Delete
          </Button>
        </footer>
      </article>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent className="sm:max-w-md">
          <DialogTitle>Delete "{task.title}"?</DialogTitle>
          <DialogDescription>
            This removes the task, its comments and activity. Linked threads keep running. Archive it instead to keep a record.
          </DialogDescription>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
              Keep task
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() =>
                writes.remove({ taskId: task.id }).then(
                  () => {
                    setConfirmDelete(false);
                    toast(`Deleted "${task.title}"`);
                  },
                  (error) => toast.error(failureText("Could not delete the task", error)),
                )
              }
            >
              Delete task
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Metadata line: lane, priority, labels, Jira, updated

type Writes = ReturnType<typeof useTaskWrites>;

function MetaRow({ task, writes }: { task: TaskDetail; writes: Writes }) {
  const board = useBoard(task.projectId);
  const lanes = (board.data?.lanes ?? []).filter((lane) => lane.projectId === task.projectId);
  const laneName = lanes.find((lane) => lane.id === task.laneId)?.name ?? task.laneName;
  return (
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-2 text-xs">
      <Picker
        label={`Lane: ${laneName}`}
        trigger={<span className="font-medium text-foreground">{laneName}</span>}
        options={lanes.map((lane) => ({ value: lane.id, label: lane.name }))}
        value={task.laneId}
        onPick={(laneId) => void writes.move(laneId)}
      />
      <Picker
        label={`Priority: ${PRIORITY_NAMES[task.priority]}`}
        trigger={
          task.priority === "none" ? (
            <span className="text-muted-foreground">No priority</span>
          ) : (
            <PriorityText priority={task.priority} />
          )
        }
        options={PRIORITIES.map((priority) => ({ value: priority, label: PRIORITY_NAMES[priority] }))}
        value={task.priority}
        onPick={(priority) => void writes.update({ priority: priority as Priority }).catch(() => undefined)}
      />
      <Labels task={task} writes={writes} />
      {task.externalRef ? <JiraChip externalRef={task.externalRef} /> : null}
      <span className="ml-1 tabular-nums text-muted-foreground" title={new Date(task.updatedAt).toLocaleString()}>
        Updated {relativeTime(task.updatedAt)} {task.updatedBy === "agent" ? "by an agent" : task.updatedBy === "system" ? "by bb" : ""}
      </span>
    </div>
  );
}

function Picker({
  label,
  trigger,
  options,
  value,
  onPick,
}: {
  label: string;
  trigger: React.ReactNode;
  options: Array<{ value: string; label: string }>;
  value: string;
  onPick: (value: string) => void;
}) {
  const portal = usePortalScopeProps();
  const { variants } = useKitMotion();
  const [open, setOpen] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const onKey = (event: ReactKeyboardEvent) => {
    const buttons = Array.from(list.current?.querySelectorAll("button") ?? []);
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown" || event.key === "j") {
      event.preventDefault();
      buttons[Math.min(buttons.length - 1, index + 1)]?.focus();
    } else if (event.key === "ArrowUp" || event.key === "k") {
      event.preventDefault();
      buttons[Math.max(0, index - 1)]?.focus();
    }
  };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={label}
          className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-state-active"
        >
          {trigger}
          <Icon name="ChevronDown" className="size-3 text-muted-foreground" aria-hidden />
        </button>
      </Popover.Trigger>
      <AnimatePresence>
        {open ? (
          <Popover.Portal forceMount>
            <Popover.Content
              {...portal}
              forceMount
              asChild
              align="start"
              sideOffset={4}
              collisionPadding={12}
              onOpenAutoFocus={(event) => {
                event.preventDefault();
                (list.current?.querySelector("[aria-checked=true]") as HTMLElement | null)?.focus();
              }}
            >
              <motion.div
                ref={list}
                role="menu"
                onKeyDown={onKey}
                variants={variants.fadeScale}
                initial="hidden"
                animate="visible"
                exit="exit"
                style={{ transformOrigin: "var(--radix-popover-content-transform-origin)" }}
                className="z-50 flex min-w-40 flex-col rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg outline-none"
              >
                {options.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={option.value === value}
                    onClick={() => {
                      setOpen(false);
                      if (option.value !== value) onPick(option.value);
                    }}
                    className="flex h-8 items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-state-hover focus-visible:bg-state-hover focus-visible:outline-none"
                  >
                    <span className="flex-1">{option.label}</span>
                    {option.value === value ? <Icon name="Check" className="size-3.5" aria-hidden /> : null}
                  </button>
                ))}
              </motion.div>
            </Popover.Content>
          </Popover.Portal>
        ) : null}
      </AnimatePresence>
    </Popover.Root>
  );
}

function Labels({ task, writes }: { task: TaskDetail; writes: Writes }) {
  const [adding, setAdding] = useState(false);
  const save = (labels: string[]) => void writes.update({ labels }).catch(() => undefined);
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {task.labels.map((label) => (
        <button
          key={label}
          type="button"
          title={`Remove label ${label}`}
          onClick={() => save(task.labels.filter((row) => row !== label))}
          className="rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Tint hue={hueFor(label)}>{label}</Tint>
        </button>
      ))}
      {adding ? (
        <input
          autoFocus
          aria-label="New label"
          placeholder="Label"
          maxLength={32}
          className="h-6 w-28 rounded-md border border-input bg-background px-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setAdding(false);
            }
            if (event.key === "Enter") {
              const value = event.currentTarget.value.trim();
              if (value && !task.labels.includes(value) && task.labels.length < 10) save([...task.labels, value]);
              event.currentTarget.value = "";
              if (!value) setAdding(false);
            }
          }}
          onBlur={() => setAdding(false)}
        />
      ) : task.labels.length < 10 ? (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="h-6 rounded-md px-1.5 text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Add label
        </button>
      ) : null}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Description

function Description({
  task,
  editing,
  setEditing,
  writes,
}: {
  task: TaskDetail;
  editing: boolean;
  setEditing: (editing: boolean) => void;
  writes: Writes;
}) {
  const [draft, setDraft] = useState(task.body);
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (editing) {
      setDraft(task.body);
      requestAnimationFrame(() => {
        const el = field.current;
        if (!el) return;
        el.focus({ preventScroll: true });
        el.setSelectionRange(el.value.length, el.value.length);
      });
    }
    // Only when editing starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  if (editing) {
    const save = () => {
      setEditing(false);
      if (draft !== task.body) void writes.update({ body: draft }).catch(() => setEditing(true));
    };
    return (
      <div className="flex flex-col gap-2">
        <textarea
          ref={field}
          aria-label="Description"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setEditing(false);
            } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              save();
            }
          }}
          rows={Math.min(18, Math.max(5, draft.split("\n").length + 1))}
          placeholder="What needs to happen, and how to check it"
          className="w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm leading-6 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
          <span className="mr-auto">Markdown</span>
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={save}>
            Save <Kbd className="ml-1 border-background/30 bg-background/15 text-background">{shortcutLabel("mod+Enter")}</Kbd>
          </Button>
        </div>
      </div>
    );
  }
  if (!task.body.trim()) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="flex h-9 items-center gap-2 self-start rounded-lg px-2 text-sm text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Icon name="Edit" className="size-3.5" aria-hidden />
        Add a description <Kbd>E</Kbd>
      </button>
    );
  }
  return (
    <div className="group/body relative max-w-[72ch]">
      <div className="text-sm leading-6 text-foreground" onDoubleClick={() => setEditing(true)}>
        <Markdown content={task.body} />
      </div>
      <button
        type="button"
        onClick={() => setEditing(true)}
        title={`Edit (${shortcutLabel("e")})`}
        className="absolute -right-1 -top-1 grid size-7 place-items-center rounded-md text-muted-foreground opacity-0 hover:bg-state-hover hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover/body:opacity-100 pointer-coarse:opacity-100"
        aria-label="Edit the description"
      >
        <Icon name="Edit" className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Threads and the live chat

function chipStatus(view: ThreadView | null): RunStatus {
  if (!view || view.state === "archived" || view.state === "missing") return "idle";
  return view.state;
}

function LinkedThread({
  threadId,
  active,
  onPick,
  onUnlink,
}: {
  threadId: string;
  active: boolean;
  onPick: () => void;
  onUnlink: () => void;
}) {
  const view = useThreadView(threadId);
  const gone = view?.state === "archived" || view?.state === "missing";
  return (
    <li
      data-kit-handoff-row={threadId}
      className={cn("group/thread flex items-center gap-1.5 rounded-lg px-1 py-0.5", active && "bg-surface-selected")}
    >
      <ThreadChip
        threadId={threadId}
        title={view?.title}
        status={chipStatus(view)}
        className={cn("min-w-0 flex-1 border-transparent bg-transparent", gone && "text-muted-foreground")}
      />
      {gone ? <span className="text-xs text-muted-foreground">{view?.state === "archived" ? "Archived" : "Deleted"}</span> : null}
      {!gone ? (
        <button
          type="button"
          onClick={onPick}
          aria-pressed={active}
          className="h-7 rounded-md px-2 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-pressed:text-foreground"
        >
          {active ? "Watching" : "Watch"}
        </button>
      ) : null}
      <button
        type="button"
        onClick={onUnlink}
        title="Unlink this thread from the task"
        className="h-7 rounded-md px-2 text-xs text-muted-foreground opacity-0 hover:bg-state-hover hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover/thread:opacity-100 pointer-coarse:opacity-100"
      >
        Unlink
      </button>
    </li>
  );
}

function ThreadsSection({
  task,
  shownChat,
  onPick,
  writes,
  landing,
}: {
  task: TaskDetail;
  shownChat: string | null;
  onPick: (threadId: string) => void;
  writes: Writes;
  /** A thread a handoff is on its way to, not linked yet. */
  landing: string | null;
}) {
  const { variants } = useKitMotion();
  const pending = landing && !task.threads.some((link) => link.threadId === landing) ? landing : null;
  const shownView = useThreadView(shownChat ?? "");
  const chatAvailable = shownChat !== null && shownView?.state !== "missing";
  if (task.threads.length === 0 && !pending) {
    return (
      <section aria-label="Threads" className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-foreground">Threads</h2>
        <p className="text-sm text-muted-foreground">
          No thread is working on this yet. <span className="whitespace-nowrap">Start work</span> sends it to a new or
          existing thread and moves the card to In progress.
        </p>
      </section>
    );
  }
  return (
    <section aria-label="Threads" className="flex flex-col gap-2">
      <h2 className="text-sm font-medium text-foreground">
        Threads <span className="text-xs font-normal tabular-nums text-muted-foreground">{task.threads.length}</span>
      </h2>
      <ul className="flex flex-col gap-0.5">
        {task.threads.map((link) => (
          <LinkedThread
            key={link.threadId}
            threadId={link.threadId}
            active={link.threadId === shownChat}
            onPick={() => onPick(link.threadId)}
            onUnlink={() =>
              void writes
                .unlink({ taskId: task.id, threadId: link.threadId })
                .catch((error) => toast.error(failureText("Could not unlink the thread", error)))
            }
          />
        ))}
        <AnimatePresence initial={false}>
          {pending ? (
            <motion.li
              key={`pending-${pending}`}
              data-kit-handoff-row={pending}
              variants={variants.listItem}
              initial="hidden"
              animate="visible"
              exit="exit"
              className="flex items-center gap-1.5 rounded-lg px-1 py-0.5"
            >
              <ThreadChip threadId={pending} className="min-w-0 flex-1 border-transparent bg-transparent" />
              <span className="pr-2 text-xs text-muted-foreground">Linking</span>
            </motion.li>
          ) : null}
        </AnimatePresence>
      </ul>
      {chatAvailable ? (
        <div className="h-[30rem] overflow-hidden rounded-lg border border-border/70 bg-background">
          {/* Read-only: opening a task must not put the caret in an agent's
              composer. The thread chip opens the thread to reply. */}
          <ThreadChat key={shownChat} threadId={shownChat!} variant="timeline" layout="contained" />
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Activity

function actorName(event: TaskEvent): string {
  if (event.actor === "agent") return "Agent";
  if (event.actor === "system") return "bb";
  return "You";
}

function eventText(event: TaskEvent): string {
  const payload = event.payload as Record<string, unknown>;
  switch (event.kind) {
    case "created":
      return payload.via ? `created this from ${String(payload.via)}` : `created this in ${String(payload.laneName ?? "the board")}`;
    case "moved":
      return payload.reason === "start-work"
        ? `started work and moved it to ${String(payload.toLaneName)}`
        : `moved it to ${String(payload.toLaneName)}`;
    case "updated": {
      const fields = Array.isArray(payload.fields) ? (payload.fields as string[]) : [];
      const names: Record<string, string> = {
        title: "the title",
        body: "the description",
        priority: "the priority",
        labels: "the labels",
        externalRef: "the Jira issue",
      };
      return `changed ${fields.map((field) => names[field] ?? field).join(" and ")}`;
    }
    case "linked":
      return "linked a thread";
    case "unlinked":
      return payload.reason === "deleted" ? "unlinked a deleted thread" : "unlinked a thread";
    case "archived":
      return "archived it";
    case "unarchived":
      return "restored it";
    default:
      return event.kind;
  }
}

function ActivityList({ taskId, events, cursor }: { taskId: string; events: TaskEvent[]; cursor: number | null }) {
  const { variants } = useKitMotion();
  const rpc = useRpc<typeof rpcContract>();
  const [older, setOlder] = useState<{ events: TaskEvent[]; cursor: number | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const shown = useMemo(() => {
    const seen = new Set(events.map((event) => event.id));
    return [...events, ...(older?.events ?? []).filter((event) => !seen.has(event.id))];
  }, [events, older]);
  const next = older ? older.cursor : cursor;
  const loadOlder = () => {
    if (next === null) return;
    setLoading(true);
    rpc
      .call("taskEvents", { taskId, before: next, limit: 50 })
      .then(
        (page) => setOlder((current) => ({ events: [...(current?.events ?? []), ...page.events], cursor: page.cursor })),
        (error) => toast.error(failureText("Could not load older activity", error)),
      )
      .finally(() => setLoading(false));
  };
  if (shown.length === 0) return null;
  return (
    <ol className="flex flex-col gap-3">
      <AnimatePresence initial={false}>
        {shown.map((event) => (
          <motion.li
            key={event.id}
            layout="position"
            variants={variants.listItem}
            initial="hidden"
            animate="visible"
            exit="exit"
            className="flex flex-col gap-1"
          >
            {event.kind === "commented" ? (
              <div className="flex flex-col gap-1 rounded-lg bg-muted/50 px-3 py-2">
                <span className="flex items-baseline gap-2 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{actorName(event)}</span>
                  <span className="tabular-nums" title={new Date(event.createdAt).toLocaleString()}>
                    {event.id < 0 ? "Sending" : relativeTime(event.createdAt)}
                  </span>
                </span>
                <div className="text-sm leading-6 text-foreground">
                  <Markdown content={String((event.payload as { body?: unknown }).body ?? "")} />
                </div>
              </div>
            ) : (
              <span className="flex items-baseline gap-2 text-xs text-muted-foreground">
                <span>
                  <span className="text-foreground">{actorName(event)}</span> {eventText(event)}
                </span>
                <span className="ml-auto shrink-0 tabular-nums" title={new Date(event.createdAt).toLocaleString()}>
                  {relativeTime(event.createdAt)}
                </span>
              </span>
            )}
          </motion.li>
        ))}
      </AnimatePresence>
      {next !== null ? (
        <li>
          <Button size="sm" variant="ghost" onClick={loadOlder} disabled={loading}>
            Show older activity
          </Button>
        </li>
      ) : null}
    </ol>
  );
}
