// The board page and the task panel are separate React trees. This carries
// the little they share: which task the panel shows, and a pending "Start
// work" request from the board's S key.
import { useSyncExternalStore } from "react";
import type { TaskCard } from "../src/schemas";

let shownTaskId: string | null = null;
let pendingStart: string | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setShownTask(taskId: string | null): void {
  if (shownTaskId === taskId) return;
  shownTaskId = taskId;
  emit();
}

export function useShownTask(): string | null {
  return useSyncExternalStore(subscribe, () => shownTaskId, () => shownTaskId);
}

/** Open the task's panel and its Start work sheet. */
export function requestStartWork(task: TaskCard, open: (task: TaskCard) => void): void {
  pendingStart = task.id;
  emit();
  open(task);
}

export function usePendingStart(): string | null {
  return useSyncExternalStore(subscribe, () => pendingStart, () => pendingStart);
}

export function clearPendingStart(): void {
  pendingStart = null;
  emit();
}
