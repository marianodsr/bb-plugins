import { experimental_PluginRpcRefusal, type BbPluginApi } from "@get-bb/plugin-sdk";
import { rpcContract } from "./contract.js";
import type { TaskService } from "./service.js";
import { StoreError, USER, type Actor } from "./store.js";

/** Turn expected failures into RPC refusals so they reach the caller typed. */
async function refusing<T>(work: () => T | Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof StoreError) {
      throw new experimental_PluginRpcRefusal({ code: error.code, message: error.message });
    }
    throw error;
  }
}

export function registerRpc(bb: BbPluginApi, service: TaskService): void {
  bb.rpc.register(rpcContract, {
    board: ({ projectId, perLane, archived }) =>
      refusing(() => service.board(projectId, { perLane, archived })),
    task: ({ taskId, eventLimit }) => ({ task: service.task(taskId, eventLimit) }),
    taskEvents: ({ taskId, before, limit }) => service.store.events(taskId, before, limit),
    threadStatuses: ({ keys }, { experimental_signal }) => service.threadStatuses(keys, experimental_signal),
    taskForThread: ({ threadId }) => {
      const taskId = service.store.taskIdForThread(threadId);
      return { task: taskId ? service.store.card(taskId) : null };
    },
    summary: () => service.summary(),
    integrations: () => service.integrations(),
    startWork: ({ taskId, threadId }) => refusing(() => service.startWork(taskId, threadId, USER)),
    taskPrompt: ({ taskId }) => refusing(() => service.taskPrompt(taskId)),

    createTask: (input, { experimental_caller: caller }) =>
      refusing(async () => {
        const via = caller.kind === "plugin" && caller.pluginId !== bb.pluginId ? caller.pluginId : undefined;
        const card = await service.createTask(
          {
            ...input,
            ...(via ? { via } : {}),
            // A reference from another plugin ("Add to Task Board" twice)
            // finds the open task instead of making a second one.
            dedupeExternalRef: input.externalRef !== undefined,
          },
          USER,
        );
        return { id: card.id };
      }),
    updateTask: ({ taskId, ...patch }) => refusing(() => service.updateTask(taskId, patch, USER)),
    moveTask: ({ taskId, ...input }) => refusing(() => service.moveTask(taskId, input, USER)),
    archiveTask: ({ taskId, archived }) => refusing(() => service.setArchived(taskId, archived, USER)),
    deleteTask: ({ taskId }) =>
      refusing(async () => {
        await service.deleteTask(taskId);
        return { deleted: true as const };
      }),
    addComment: ({ taskId, body }) => refusing(() => service.addComment(taskId, body, USER)),
    linkThread: ({ taskId, threadId }) => refusing(() => service.linkThread(taskId, threadId, USER)),
    unlinkThread: ({ taskId, threadId }) =>
      refusing(async () => ({ unlinked: (await service.unlinkThread(threadId, USER, taskId)) !== null })),
    createLane: (input) =>
      refusing(async () => {
        await service.requireProject(input.projectId);
        return service.store.createLane(input);
      }),
    updateLane: ({ laneId, ...patch }) => refusing(() => service.store.updateLane(laneId, patch)),
    moveLane: ({ laneId, afterLaneId }) => refusing(() => service.store.moveLane(laneId, afterLaneId)),
    deleteLane: ({ laneId, moveTasksTo }) =>
      refusing(() => {
        service.store.deleteLane(laneId, moveTasksTo ?? null, USER as Actor);
        return { deleted: true as const };
      }),
  });
}
