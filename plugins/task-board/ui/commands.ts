// Palette commands. Commands run outside React, so the navigation and RPC
// handles they need are captured by a hook bb keeps mounted (the nav badge).
import type { BbNavigate, PluginRpcClient } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { RpcContract } from "../src/contract";

interface Handles {
  navigate: BbNavigate;
  rpc: PluginRpcClient<RpcContract>;
}

let handles: Handles | null = null;
let pendingNewTask = false;
const newTaskListeners = new Set<() => void>();

export function setCommandHandles(next: Handles): void {
  handles = next;
}

/** The board consumes this on mount (or at once, if it is open). */
export function takePendingNewTask(): boolean {
  const pending = pendingNewTask;
  pendingNewTask = false;
  return pending;
}

export function onNewTaskRequest(listener: () => void): () => void {
  newTaskListeners.add(listener);
  return () => newTaskListeners.delete(listener);
}

export const COMMANDS = [
  {
    id: "open-board",
    title: "Task Board: Open the board",
    run() {
      handles?.navigate.toPluginPanel("board");
    },
  },
  {
    id: "new-task",
    title: "Task Board: New task",
    run() {
      pendingNewTask = true;
      handles?.navigate.toPluginPanel("board");
      for (const listener of newTaskListeners) listener();
    },
  },
  {
    id: "open-thread-task",
    title: "Task Board: Open this thread's task",
    isAvailable: (context: { threadId: string | null }) => context.threadId !== null,
    async run(context: { threadId: string | null }) {
      if (!handles || !context.threadId) return;
      const { task } = await handles.rpc.call("taskForThread", { threadId: context.threadId });
      if (!task) {
        toast("This thread is not linked to a task. Start work from a card to link one.");
        return;
      }
      handles.navigate.toPluginPanel("board", { subPath: `task/${task.id}` });
    },
  },
];
