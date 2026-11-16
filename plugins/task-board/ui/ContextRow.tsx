// The linked task beside a thread: a row in the thread context card, or a
// segment of the context banner above the composer, whichever bb shows.
import {
  experimental_ThreadContextCardRow as ThreadContextCardRow,
  experimental_useRpcQuery,
  experimental_useThreadContextKind,
  useBbNavigate,
  type ExperimentalThreadContextCardProps,
  type ExperimentalThreadContextSegmentInput,
  type ExperimentalThreadContextSegmentProps,
} from "@get-bb/plugin-sdk/app";
import { Icon } from "../components/ui/icon";
import { rpcContract } from "../src/contract";
import { KIND_NAMES } from "./model";

function useLinkedTask(threadId: string) {
  const { data } = experimental_useRpcQuery({ contract: rpcContract, method: "taskForThread", input: { threadId } });
  return data?.task ?? null;
}

export function TaskContextRow({ threadId }: ExperimentalThreadContextCardProps) {
  const navigate = useBbNavigate();
  const task = useLinkedTask(threadId);
  if (!task) return null;
  return (
    <ThreadContextCardRow
      icon="ListTodo"
      label={task.title}
      title={`Task: ${task.title}`}
      trailing={<span className="text-xs text-muted-foreground">{KIND_NAMES[task.laneKind]}</span>}
      onClick={() => navigate.toPluginPanel("board", { subPath: `task/${task.id}` })}
    />
  );
}

/** Shown only in banner mode, and only for a linked thread. */
export function useTaskSegmentVisible({ threadId }: ExperimentalThreadContextSegmentInput): boolean {
  const kind = experimental_useThreadContextKind();
  const task = useLinkedTask(threadId);
  return kind === "banner" && task !== null;
}

export function TaskContextSegment({ threadId }: ExperimentalThreadContextSegmentProps) {
  const navigate = useBbNavigate();
  const task = useLinkedTask(threadId);
  if (!task) return null;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-sm">
      <Icon name="ListTodo" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="shrink-0 text-muted-foreground">Task</span>
      <button
        type="button"
        onClick={() => navigate.toPluginPanel("board", { subPath: `task/${task.id}` })}
        title={`Open "${task.title}" on the Task Board`}
        className="min-w-0 truncate rounded-sm text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {task.title}
      </button>
      <span className="shrink-0 text-xs text-muted-foreground">{KIND_NAMES[task.laneKind]}</span>
    </span>
  );
}
