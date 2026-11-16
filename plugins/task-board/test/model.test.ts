import { describe, expect, it } from "vitest";
import type { Lane, TaskCard } from "../src/schemas";
import {
  applyMove,
  columnsOf,
  dropAnchors,
  dropIndex,
  laneForDrop,
  matches,
  moveCursor,
  moveLifted,
  NO_FILTERS,
  parseRoute,
  previewLift,
  routePath,
  type BoardData,
} from "../ui/model";

function lane(id: string, kind: Lane["kind"], projectId = "proj_a"): Lane {
  return { id, projectId, name: id, kind, position: id, taskCount: 0 };
}

function task(id: string, laneId: string, extra: Partial<TaskCard> = {}): TaskCard {
  return {
    id,
    projectId: "proj_a",
    laneId,
    laneKind: "todo",
    position: id,
    title: id,
    preview: "",
    priority: "none",
    labels: [],
    externalRef: null,
    threadIds: [],
    commentCount: 0,
    createdAt: 0,
    updatedAt: 0,
    updatedBy: "user",
    archivedAt: null,
    ...extra,
  };
}

function board(): BoardData {
  const lanes = [lane("todo", "todo"), lane("doing", "doing"), lane("review", "review")];
  const tasks = [task("a", "todo"), task("b", "todo"), task("c", "todo"), task("d", "doing")];
  return {
    projects: [{ id: "proj_a", name: "A" }],
    lanes: lanes.map((row) => ({ ...row, taskCount: tasks.filter((t) => t.laneId === row.id).length })),
    tasks,
    truncated: false,
  };
}

const ids = (data: BoardData, laneId: string) => data.tasks.filter((t) => t.laneId === laneId).map((t) => t.id);

describe("applyMove (optimistic prediction)", () => {
  it("places after the anchor, before it, or at an edge, like the server", () => {
    const start = board();
    expect(ids(applyMove(start, { taskId: "c", laneId: "todo", afterTaskId: "a" }), "todo")).toEqual(["a", "c", "b"]);
    expect(ids(applyMove(start, { taskId: "a", laneId: "todo", beforeTaskId: "c" }), "todo")).toEqual(["b", "a", "c"]);
    expect(ids(applyMove(start, { taskId: "c", laneId: "todo", placement: "top" }), "todo")).toEqual(["c", "a", "b"]);
    const moved = applyMove(start, { taskId: "a", laneId: "doing", afterTaskId: "d" });
    expect(ids(moved, "doing")).toEqual(["d", "a"]);
    expect(moved.tasks.find((t) => t.id === "a")!.laneKind).toBe("doing");
    expect(moved.lanes.map((row) => row.taskCount)).toEqual([2, 2, 0]);
    // Input untouched (updaters must be pure).
    expect(ids(start, "todo")).toEqual(["a", "b", "c"]);
  });

  it("ignores an anchor that is not in the target lane", () => {
    expect(ids(applyMove(board(), { taskId: "a", laneId: "doing", afterTaskId: "b" }), "doing")).toEqual(["d", "a"]);
    expect(ids(applyMove(board(), { taskId: "a", laneId: "doing", afterTaskId: "b", placement: "top" }), "doing")).toEqual(["a", "d"]);
  });

  it("drops into an empty lane and keeps the array in lane order", () => {
    const moved = applyMove(board(), { taskId: "b", laneId: "review" });
    expect(ids(moved, "review")).toEqual(["b"]);
    const columns = columnsOf(moved, "project");
    expect(columns.map((column) => column.tasks.map((t) => t.id))).toEqual([["a", "c"], ["d"], ["b"]]);
  });
});

describe("drop geometry", () => {
  it("turns a pointer y into an index among the other cards' midpoints", () => {
    expect(dropIndex(5, [10, 30, 50])).toBe(0);
    expect(dropIndex(31, [10, 30, 50])).toBe(2);
    expect(dropIndex(99, [10, 30, 50])).toBe(3);
  });

  it("names both neighbours, excluding the dragged card", () => {
    const lane = board().tasks.filter((t) => t.laneId === "todo");
    expect(dropAnchors(lane, 0, "c")).toEqual({ afterTaskId: null, beforeTaskId: "a", placement: "top" });
    expect(dropAnchors(lane, 1, "c")).toEqual({ afterTaskId: "a", beforeTaskId: "b", placement: "bottom" });
    expect(dropAnchors(lane, 9, "a")).toEqual({ afterTaskId: "c", beforeTaskId: null, placement: "bottom" });
  });

  it("maps a kind column to the task's own project lane in the all-projects view", () => {
    const data: BoardData = {
      ...board(),
      lanes: [lane("todo", "todo"), lane("doing", "doing"), lane("todo-b", "todo", "proj_b"), lane("doing-b", "doing", "proj_b")],
    };
    const columns = columnsOf(data, "all");
    expect(columns.map((column) => column.laneIds)).toEqual([["todo", "todo-b"], ["doing", "doing-b"], [], []]);
    expect(laneForDrop(data, columns[1]!, task("x", "todo-b", { projectId: "proj_b" }))).toBe("doing-b");
    expect(laneForDrop(data, columns[2]!, task("x", "todo-b", { projectId: "proj_b" }))).toBeNull();
  });
});

describe("keyboard", () => {
  const cols = [{ tasks: [{ id: "a" }, { id: "b" }, { id: "c" }] }, { tasks: [] as { id: string }[] }, { tasks: [{ id: "d" }] }];

  it("moves focus within and across lanes, skipping empty lanes", () => {
    expect(moveCursor(cols, { column: 0, row: 0 }, "down")).toEqual({ column: 0, row: 1 });
    expect(moveCursor(cols, { column: 0, row: 2 }, "down")).toEqual({ column: 0, row: 2 });
    expect(moveCursor(cols, { column: 0, row: 2 }, "right")).toEqual({ column: 2, row: 0 });
    expect(moveCursor(cols, { column: 2, row: 0 }, "left")).toEqual({ column: 0, row: 0 });
    expect(moveCursor(cols, { column: 0, row: 1 }, "last")).toEqual({ column: 0, row: 2 });
    expect(moveCursor(cols, { column: 2, row: 0 }, "right")).toEqual({ column: 2, row: 0 });
  });

  it("lets a lifted card enter empty lanes and the slot after the last card", () => {
    expect(moveLifted(cols, "c", { column: 0, row: 2 }, "right")).toEqual({ column: 1, row: 0 });
    expect(moveLifted(cols, "c", { column: 1, row: 0 }, "right")).toEqual({ column: 2, row: 0 });
    expect(moveLifted(cols, "c", { column: 2, row: 0 }, "down")).toEqual({ column: 2, row: 1 });
    expect(moveLifted(cols, "c", { column: 2, row: 1 }, "down")).toEqual({ column: 2, row: 1 });
    expect(moveLifted(cols, "a", { column: 0, row: 0 }, "left")).toEqual({ column: 0, row: 0 });
  });

  it("previews the lifted card at its target", () => {
    const preview = previewLift(cols, { id: "a" }, { column: 2, row: 1 });
    expect(preview.map((tasks) => tasks.map((t) => t.id))).toEqual([["b", "c"], [], ["d", "a"]]);
  });
});

describe("filters and routes", () => {
  it("matches every word across title, id, labels and the Jira key", () => {
    const t = task("tsk_1", "todo", {
      title: "Fix login",
      labels: ["auth"],
      externalRef: { kind: "jira", key: "ENG-9", url: "https://x" },
    });
    expect(matches(t, { ...NO_FILTERS, query: "login eng-9" })).toBe(true);
    expect(matches(t, { ...NO_FILTERS, query: "login billing" })).toBe(false);
    expect(matches(t, { ...NO_FILTERS, labels: ["ui"] })).toBe(false);
    expect(matches(t, { ...NO_FILTERS, priorities: ["none"] })).toBe(true);
    expect(matches(t, { ...NO_FILTERS, withThreads: true })).toBe(false);
  });

  it("parses the board's sub-paths, including the cross-plugin task route", () => {
    expect(parseRoute("")).toEqual({ kind: "default", taskId: null });
    expect(parseRoute("task/tsk_abcdefghij")).toEqual({ kind: "task", taskId: "tsk_abcdefghij" });
    expect(parseRoute("p/proj_x/task/tsk_1")).toEqual({ kind: "project", projectId: "proj_x", taskId: "tsk_1" });
    expect(parseRoute("all")).toEqual({ kind: "all", taskId: null });
    expect(parseRoute(routePath("proj_x", "tsk_1"))).toEqual({ kind: "project", projectId: "proj_x", taskId: "tsk_1" });
    expect(parseRoute(routePath("all", null))).toEqual({ kind: "all", taskId: null });
  });
});
