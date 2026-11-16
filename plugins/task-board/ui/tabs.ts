// The task panel: an action tab in the board page's side panel, one instance
// at a time, whose persisted params name the task.
import type { ExperimentalPanelController, JsonValue } from "@get-bb/plugin-sdk/app";

export type TaskParams = { taskId: string };

export const BOARD_PANEL_ID = "board";

export const TASK_TAB = {
  id: "task",
  context: { kind: "nav-panel" as const, panelId: BOARD_PANEL_ID },
  availability: "action" as const,
};

export function taskIdFromParams(params: JsonValue | null): string | null {
  if (typeof params !== "object" || params === null || Array.isArray(params)) return null;
  const taskId = (params as { taskId?: unknown }).taskId;
  return typeof taskId === "string" && /^tsk_[a-z0-9]{10}$/u.test(taskId) ? taskId : null;
}

/**
 * Show one task in the panel, replacing whichever task tab was open, so the
 * panel holds one task document like DESIGN.md's detail panel.
 */
export function openTaskTab(panel: ExperimentalPanelController, taskId: string, title: string): boolean {
  const { tabs } = panel.getTabs();
  const stale = tabs.filter(
    (tab) =>
      tab.detail.kind === "plugin" &&
      tab.detail.tab.id === TASK_TAB.id &&
      tab.detail.tab.context.kind === "nav-panel" &&
      taskIdFromParams(tab.detail.params) !== taskId,
  );
  const accepted = panel.openTab({ tab: TASK_TAB, params: { taskId }, title });
  for (const tab of stale) panel.closeTab(tab.key);
  return accepted;
}
