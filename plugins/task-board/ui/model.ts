// Pure board logic: grouping, optimistic moves, drop anchors, keyboard
// movement, filters and routes. No React, so it is unit-tested directly.
import type { Lane, LaneKind, Priority, TaskCard } from "../src/schemas";

export type BoardData = {
  projects: Array<{ id: string; name: string }>;
  lanes: Lane[];
  tasks: TaskCard[];
  truncated: boolean;
};

/** A column on screen. In the all-projects view a column is a lane kind. */
export interface Column {
  id: string;
  name: string;
  kind: LaneKind;
  /** Real lane ids this column shows (one, or one per project for "all"). */
  laneIds: string[];
  /** Non-archived tasks in the column, including beyond the page. */
  total: number;
  tasks: TaskCard[];
}

export const KIND_ORDER: LaneKind[] = ["todo", "doing", "review", "done"];
export const KIND_NAMES: Record<LaneKind, string> = {
  todo: "To do",
  doing: "In progress",
  review: "Review",
  done: "Done",
};

export function kindColumnId(kind: LaneKind): string {
  return `kind:${kind}`;
}

/** Columns for one project's board (lanes) or all projects (lane kinds). */
export function columnsOf(board: BoardData, scope: "project" | "all"): Column[] {
  if (scope === "project") {
    return board.lanes.map((lane) => ({
      id: lane.id,
      name: lane.name,
      kind: lane.kind,
      laneIds: [lane.id],
      total: lane.taskCount,
      tasks: board.tasks.filter((task) => task.laneId === lane.id),
    }));
  }
  return KIND_ORDER.map((kind) => {
    const lanes = board.lanes.filter((lane) => lane.kind === kind);
    const ids = new Set(lanes.map((lane) => lane.id));
    return {
      id: kindColumnId(kind),
      name: KIND_NAMES[kind],
      kind,
      laneIds: [...ids],
      total: lanes.reduce((sum, lane) => sum + lane.taskCount, 0),
      tasks: board.tasks.filter((task) => ids.has(task.laneId)),
    };
  });
}

/** Text, label, priority and thread filters, all optional. */
export interface Filters {
  query: string;
  labels: string[];
  priorities: Priority[];
  withThreads: boolean;
}

export const NO_FILTERS: Filters = { query: "", labels: [], priorities: [], withThreads: false };

export function isFiltering(filters: Filters): boolean {
  return (
    filters.query.trim() !== "" ||
    filters.labels.length > 0 ||
    filters.priorities.length > 0 ||
    filters.withThreads
  );
}

export function matches(task: TaskCard, filters: Filters): boolean {
  const query = filters.query.trim().toLowerCase();
  if (query) {
    const haystack = [task.title, task.preview, task.id, task.externalRef?.key ?? "", ...task.labels]
      .join("\n")
      .toLowerCase();
    if (!query.split(/\s+/u).every((word) => haystack.includes(word))) return false;
  }
  if (filters.labels.length > 0 && !filters.labels.some((label) => task.labels.includes(label))) return false;
  if (filters.priorities.length > 0 && !filters.priorities.includes(task.priority)) return false;
  if (filters.withThreads && task.threadIds.length === 0) return false;
  return true;
}

export function allLabels(tasks: TaskCard[]): string[] {
  return [...new Set(tasks.flatMap((task) => task.labels))].sort((a, b) => a.localeCompare(b));
}

// ---------------------------------------------------------------------------
// Moves

export interface MoveInput {
  taskId: string;
  laneId: string;
  afterTaskId?: string | null;
  beforeTaskId?: string | null;
  placement?: "top" | "bottom";
}

/**
 * The board after a move, predicted the way the server applies it: directly
 * after `afterTaskId` if it is in the lane, else before `beforeTaskId`, else
 * at `placement`. Pure: returns a new board and leaves the input untouched.
 */
export function applyMove(board: BoardData, input: MoveInput): BoardData {
  const moving = board.tasks.find((task) => task.id === input.taskId);
  const lane = board.lanes.find((row) => row.id === input.laneId);
  if (!moving || !lane) return board;
  const rest = board.tasks.filter((task) => task.id !== input.taskId);
  const moved: TaskCard = { ...moving, laneId: lane.id, laneKind: lane.kind, updatedBy: "user" };
  const inLane = (task: TaskCard) => task.laneId === lane.id;
  let index = -1;
  const after = input.afterTaskId ? rest.findIndex((task) => task.id === input.afterTaskId && inLane(task)) : -1;
  if (after >= 0) index = after + 1;
  else {
    const before = input.beforeTaskId ? rest.findIndex((task) => task.id === input.beforeTaskId && inLane(task)) : -1;
    if (before >= 0) index = before;
  }
  if (index < 0) {
    const laneIndexes = rest.flatMap((task, at) => (inLane(task) ? [at] : []));
    if (input.placement === "top") index = laneIndexes[0] ?? insertionPointForEmptyLane(board, rest, lane.id);
    else index = laneIndexes.length > 0 ? laneIndexes[laneIndexes.length - 1]! + 1 : insertionPointForEmptyLane(board, rest, lane.id);
  }
  const tasks = [...rest.slice(0, index), moved, ...rest.slice(index)];
  const lanes =
    moving.laneId === lane.id
      ? board.lanes
      : board.lanes.map((row) =>
          row.id === lane.id
            ? { ...row, taskCount: row.taskCount + 1 }
            : row.id === moving.laneId
              ? { ...row, taskCount: Math.max(0, row.taskCount - 1) }
              : row,
        );
  return { ...board, lanes, tasks };
}

/** Keep the task array in lane order: an empty lane's first task goes after earlier lanes' tasks. */
function insertionPointForEmptyLane(board: BoardData, rest: TaskCard[], laneId: string): number {
  const order = new Map(board.lanes.map((lane, index) => [lane.id, index]));
  const target = order.get(laneId) ?? 0;
  const firstLater = rest.findIndex((task) => (order.get(task.laneId) ?? 0) > target);
  return firstLater < 0 ? rest.length : firstLater;
}

/**
 * Anchors for dropping `taskId` at `index` among `laneTasks` (the column's
 * tasks as shown, the dragged one excluded). Both neighbours are sent; the
 * server uses whichever is still in the lane.
 */
export function dropAnchors(
  laneTasks: TaskCard[],
  index: number,
  taskId: string,
): { afterTaskId: string | null; beforeTaskId: string | null; placement: "top" | "bottom" } {
  const others = laneTasks.filter((task) => task.id !== taskId);
  const clamped = Math.max(0, Math.min(index, others.length));
  return {
    afterTaskId: others[clamped - 1]?.id ?? null,
    beforeTaskId: others[clamped]?.id ?? null,
    placement: clamped === 0 ? "top" : "bottom",
  };
}

/** Index to drop at, from the pointer's y and the midpoints of the other cards. */
export function dropIndex(pointerY: number, midpoints: number[]): number {
  let index = 0;
  while (index < midpoints.length && pointerY > midpoints[index]!) index += 1;
  return index;
}

/**
 * For a column that shows several real lanes (all-projects view), the lane a
 * task dropped into belongs to: the task's own project's lane of that kind.
 */
export function laneForDrop(board: BoardData, column: Column, task: TaskCard): string | null {
  if (column.laneIds.length === 1) return column.laneIds[0]!;
  const lane = board.lanes.find((row) => row.kind === column.kind && row.projectId === task.projectId);
  return lane?.id ?? null;
}

// ---------------------------------------------------------------------------
// Keyboard

export interface Cursor {
  column: number;
  row: number;
}

/** Where the focus goes for a key, over the visible columns. */
export function moveCursor(
  columns: Array<{ tasks: unknown[] }>,
  cursor: Cursor,
  key: "up" | "down" | "left" | "right" | "first" | "last",
): Cursor {
  if (columns.length === 0) return cursor;
  const column = Math.max(0, Math.min(cursor.column, columns.length - 1));
  const size = columns[column]!.tasks.length;
  switch (key) {
    case "up":
      return { column, row: Math.max(0, cursor.row - 1) };
    case "down":
      return { column, row: Math.max(0, Math.min(size - 1, cursor.row + 1)) };
    case "first":
      return { column, row: 0 };
    case "last":
      return { column, row: Math.max(0, size - 1) };
    case "left":
    case "right": {
      const step = key === "left" ? -1 : 1;
      let next = column + step;
      // Skip empty columns when moving focus between cards.
      while (next >= 0 && next < columns.length && columns[next]!.tasks.length === 0) next += step;
      if (next < 0 || next >= columns.length) return { column, row: cursor.row };
      const nextSize = columns[next]!.tasks.length;
      return { column: next, row: Math.min(cursor.row, nextSize - 1) };
    }
  }
}

/**
 * A lifted card's target while moving it with the keyboard. Unlike focus,
 * a lifted card may enter empty columns, and its row can be one past the end.
 */
export function moveLifted(
  columns: Array<{ tasks: Array<{ id: string }> }>,
  taskId: string,
  target: Cursor,
  key: "up" | "down" | "left" | "right",
): Cursor {
  const countWithout = (column: number) => columns[column]!.tasks.filter((task) => task.id !== taskId).length;
  switch (key) {
    case "up":
      return { column: target.column, row: Math.max(0, target.row - 1) };
    case "down":
      return { column: target.column, row: Math.min(countWithout(target.column), target.row + 1) };
    case "left":
    case "right": {
      const next = target.column + (key === "left" ? -1 : 1);
      if (next < 0 || next >= columns.length) return target;
      return { column: next, row: Math.min(target.row, countWithout(next)) };
    }
  }
}

/** Show a lifted card at its target: the columns as they would look after the drop. */
export function previewLift<T extends { id: string }>(
  columns: Array<{ tasks: T[] }>,
  task: T,
  target: Cursor,
): T[][] {
  return columns.map((column, index) => {
    const others = column.tasks.filter((row) => row.id !== task.id);
    if (index !== target.column) return others;
    return [...others.slice(0, target.row), task, ...others.slice(target.row)];
  });
}

// ---------------------------------------------------------------------------
// Routes inside the board panel (subPath)

export type Route =
  | { kind: "default"; taskId: string | null }
  | { kind: "project"; projectId: string; taskId: string | null }
  | { kind: "all"; taskId: string | null }
  /** Cross-plugin contract: /plugins/task-board/board/task/<id>. */
  | { kind: "task"; taskId: string };

export function parseRoute(subPath: string): Route {
  const parts = subPath.split("/").filter(Boolean).map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
  const taskAt = (index: number) => (parts[index] === "task" && parts[index + 1] ? parts[index + 1]! : null);
  if (parts[0] === "task" && parts[1]) return { kind: "task", taskId: parts[1] };
  if (parts[0] === "all") return { kind: "all", taskId: taskAt(1) };
  if (parts[0] === "p" && parts[1]) return { kind: "project", projectId: parts[1], taskId: taskAt(2) };
  return { kind: "default", taskId: null };
}

export function routePath(scope: string | "all", taskId: string | null): string {
  const base = scope === "all" ? "all" : `p/${scope}`;
  return taskId ? `${base}/task/${taskId}` : base;
}
