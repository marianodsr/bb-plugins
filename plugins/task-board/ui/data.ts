// Live reads and optimistic writes. Reads refresh through the server's tag
// invalidation; writes predict the board first and reconcile on refresh. A
// rejected write removes its own prediction, so the card moves back.
import {
  experimental_PluginRpcCallError,
  experimental_useRpcMutation,
  experimental_useRpcQuery,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { rpcContract } from "../src/contract";
import type { TaskCard } from "../src/schemas";
import { applyMove, type BoardData } from "./model";

export const PER_LANE = 200;

export function boardInput(scope: string) {
  return { projectId: scope === "all" ? null : scope, perLane: PER_LANE, archived: false };
}

export function useBoard(scope: string | null) {
  return experimental_useRpcQuery({
    contract: rpcContract,
    method: "board",
    input: boardInput(scope ?? "all"),
    enabled: scope !== null,
  });
}

export function useTask(taskId: string | null) {
  return experimental_useRpcQuery({
    contract: rpcContract,
    method: "task",
    input: { taskId: taskId ?? "tsk_0000000000", eventLimit: 50 },
    enabled: taskId !== null,
  });
}

export function useSummary() {
  return experimental_useRpcQuery({ contract: rpcContract, method: "summary", input: null });
}

export function useIntegrations() {
  return experimental_useRpcQuery({ contract: rpcContract, method: "integrations", input: null });
}

/** A message for a failed write that says what failed, without apology. */
export function failureText(action: string, error: unknown): string {
  const reason =
    error instanceof experimental_PluginRpcCallError || error instanceof Error ? error.message : String(error);
  return `${action}: ${reason}`;
}

/** Ids for optimistic creates are made before the write, so replays agree. */
export function newTaskId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(10);
  globalThis.crypto.getRandomValues(bytes);
  return `tsk_${[...bytes].map((byte) => alphabet[byte % alphabet.length]).join("")}`;
}

/** Times for optimistic creates, recorded once per id before the write. */
const createdAt = new Map<string, number>();

export function optimisticCard(input: {
  id: string;
  title: string;
  laneId: string;
  projectId: string;
  laneKind: TaskCard["laneKind"];
}): TaskCard {
  const at = createdAt.get(input.id) ?? 0;
  return {
    id: input.id,
    projectId: input.projectId,
    laneId: input.laneId,
    laneKind: input.laneKind,
    position: "",
    title: input.title,
    preview: "",
    priority: "none",
    labels: [],
    externalRef: null,
    threadIds: [],
    commentCount: 0,
    createdAt: at,
    updatedAt: at,
    updatedBy: "user",
    archivedAt: null,
  };
}

export function useBoardWrites(scope: string | null) {
  const input = boardInput(scope ?? "all");

  const move = experimental_useRpcMutation({
    contract: rpcContract,
    method: "moveTask",
    optimistic(write, cache) {
      cache.update("board", input, (board) => applyMove(board as BoardData, write) as typeof board);
    },
  });

  const create = experimental_useRpcMutation({
    contract: rpcContract,
    method: "createTask",
    optimistic(write, cache) {
      if (!write.id || !write.laneId) return;
      const laneId = write.laneId;
      cache.update("board", input, (board) => {
        const lane = board.lanes.find((row) => row.id === laneId);
        if (!lane || board.tasks.some((task) => task.id === write.id)) return board;
        const card = optimisticCard({
          id: write.id!,
          title: write.title.trim(),
          laneId,
          projectId: lane.projectId,
          laneKind: lane.kind,
        });
        const withCard = { ...board, tasks: [...board.tasks, card] };
        const placed = applyMove(withCard as BoardData, {
          taskId: card.id,
          laneId,
          placement: write.placement ?? "bottom",
        });
        return placed as typeof board;
      });
    },
  });

  const update = experimental_useRpcMutation({
    contract: rpcContract,
    method: "updateTask",
    optimistic(write, cache) {
      cache.update("board", input, (board) => ({
        ...board,
        tasks: board.tasks.map((task) =>
          task.id === write.taskId
            ? {
                ...task,
                ...(write.title !== undefined ? { title: write.title } : {}),
                ...(write.priority !== undefined ? { priority: write.priority } : {}),
                ...(write.labels !== undefined ? { labels: write.labels } : {}),
              }
            : task,
        ),
      }));
      cache.update("task", { taskId: write.taskId, eventLimit: 50 }, (current) =>
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

  const archive = experimental_useRpcMutation({
    contract: rpcContract,
    method: "archiveTask",
    optimistic(write, cache) {
      if (!write.archived) return;
      cache.update("board", input, (board) => ({
        ...board,
        tasks: board.tasks.filter((task) => task.id !== write.taskId),
        lanes: board.lanes.map((lane) =>
          board.tasks.some((task) => task.id === write.taskId && task.laneId === lane.id)
            ? { ...lane, taskCount: Math.max(0, lane.taskCount - 1) }
            : lane,
        ),
      }));
    },
  });

  return {
    move: (write: Parameters<typeof move.mutate>[0], title: string) =>
      move.mutate(write).catch((error) => {
        toast.error(failureText(`Could not move "${title}"`, error));
      }),
    create: (write: Parameters<typeof create.mutate>[0] & { id: string }) => {
      createdAt.set(write.id, Date.now());
      return create.mutate(write);
    },
    update: (write: Parameters<typeof update.mutate>[0]) =>
      update.mutate(write).catch((error) => {
        toast.error(failureText("Could not save the task", error));
        throw error;
      }),
    archive: (taskId: string, title: string) =>
      archive.mutate({ taskId, archived: true }).then(
        () => {
          toast(`Archived "${title}"`, {
            action: { label: "Undo", onClick: () => void archive.mutate({ taskId, archived: false }) },
          });
        },
        (error) => {
          toast.error(failureText(`Could not archive "${title}"`, error));
        },
      ),
  };
}

export type BoardWrites = ReturnType<typeof useBoardWrites>;
