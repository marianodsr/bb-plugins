// Task Board storage: the plugin's SQLite tables and every read and write.
//
// All writes go through `commit`, which runs the change in one transaction,
// records which projects, tasks and threads it touched, and hands that set to
// `onCommit` exactly once. The plugin wires `onCommit` to tag invalidation, so a
// write from the app, the CLI, an agent tool or a background event refreshes
// every open read once.
import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { keyBetween } from "./ordering.js";
import type {
  ActorKind,
  EventKind,
  ExternalRef,
  Lane,
  LaneKind,
  Priority,
  TaskCard,
  TaskDetail,
  TaskEvent,
} from "./schemas.js";

export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE lanes (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    position TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX lanes_project ON lanes(project_id, position)`,
  `CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    lane_id TEXT NOT NULL,
    position TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'none',
    labels TEXT NOT NULL DEFAULT '[]',
    external_ref TEXT,
    external_key TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT NOT NULL,
    archived_at INTEGER
  )`,
  `CREATE INDEX tasks_lane ON tasks(lane_id, archived_at, position)`,
  `CREATE INDEX tasks_project ON tasks(project_id, archived_at)`,
  `CREATE INDEX tasks_external ON tasks(project_id, external_key)`,
  `CREATE TABLE task_threads (
    task_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    linked_at INTEGER NOT NULL,
    PRIMARY KEY (task_id, thread_id)
  )`,
  `CREATE UNIQUE INDEX task_threads_thread ON task_threads(thread_id)`,
  `CREATE TABLE task_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    actor TEXT NOT NULL,
    actor_thread_id TEXT,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX task_events_task ON task_events(task_id, id)`,
  `CREATE INDEX task_events_kind ON task_events(task_id, kind)`,
  // Early builds created default lanes on any read. Boards without a task are
  // only those defaults; drop them so lanes exist only where the user opened a
  // board or created a task.
  `DELETE FROM lanes WHERE project_id NOT IN (SELECT DISTINCT project_id FROM tasks)`,
];

export const DEFAULT_LANES: ReadonlyArray<{ name: string; kind: LaneKind }> = [
  { name: "To do", kind: "todo" },
  { name: "In progress", kind: "doing" },
  { name: "Review", kind: "review" },
  { name: "Done", kind: "done" },
];

export interface Actor {
  kind: ActorKind;
  /** The agent's own thread when kind is "agent". */
  threadId: string | null;
}

export const USER: Actor = { kind: "user", threadId: null };
export const SYSTEM: Actor = { kind: "system", threadId: null };

/** What one commit touched. */
export interface ChangeSet {
  projects: Set<string>;
  tasks: Set<string>;
  /** Threads whose link changed. */
  threads: Set<string>;
}

export class StoreError extends Error {
  constructor(
    readonly code: "not_found" | "conflict" | "invalid",
    message: string,
  ) {
    super(message);
    this.name = "StoreError";
  }
}

interface LaneRow {
  id: string;
  project_id: string;
  name: string;
  kind: LaneKind;
  position: string;
}

interface TaskRow {
  id: string;
  project_id: string;
  title: string;
  body: string;
  lane_id: string;
  position: string;
  priority: Priority;
  labels: string;
  external_ref: string | null;
  created_at: number;
  updated_at: number;
  updated_by: ActorKind;
  archived_at: number | null;
}

interface EventRow {
  id: number;
  task_id: string;
  actor: ActorKind;
  actor_thread_id: string | null;
  kind: EventKind;
  payload: string;
  created_at: number;
}

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function newId(prefix: "tsk" | "lan"): string {
  const bytes = randomBytes(10);
  let id = "";
  for (const byte of bytes) id += ID_ALPHABET[byte % ID_ALPHABET.length];
  return `${prefix}_${id}`;
}

const PREVIEW_MAX = 200;

function preview(body: string): string {
  const flat = body.replace(/\s+/gu, " ").trim();
  return flat.length > PREVIEW_MAX ? `${flat.slice(0, PREVIEW_MAX - 1)}…` : flat;
}

function externalKey(ref: ExternalRef | null): string | null {
  return ref === null ? null : `${ref.kind}:${ref.key}`;
}

export interface CreateTaskInput {
  id?: string;
  projectId: string;
  title: string;
  body?: string;
  laneId?: string;
  priority?: Priority;
  labels?: string[];
  externalRef?: ExternalRef | null;
  placement?: "top" | "bottom";
  /** Shown in the created event, e.g. "jira-viewer". */
  via?: string;
}

export interface UpdateTaskInput {
  title?: string;
  body?: string;
  priority?: Priority;
  labels?: string[];
  externalRef?: ExternalRef | null;
}

export interface MoveTaskInput {
  laneId: string;
  /** Place directly after this task (wins when both anchors are usable). */
  afterTaskId?: string | null;
  /** Place directly before this task. */
  beforeTaskId?: string | null;
  /** Without a usable anchor: top or bottom of the lane (default bottom). */
  placement?: "top" | "bottom";
}

export interface ListTasksQuery {
  projectId: string | null;
  laneId?: string;
  query?: string;
  label?: string;
  archived?: boolean;
  limit: number;
  offset: number;
}

export class TaskStore {
  private readonly now: () => number;

  constructor(
    private readonly db: Database.Database,
    private readonly onCommit: (change: ChangeSet) => void,
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  // ---------------------------------------------------------------------------
  // The write path

  private commit<T>(work: (change: ChangeSet) => T): T {
    const change: ChangeSet = {
      projects: new Set(),
      tasks: new Set(),
      threads: new Set(),
    };
    const result = this.db.transaction(() => work(change))();
    if (change.projects.size + change.tasks.size + change.threads.size > 0) {
      this.onCommit(change);
    }
    return result;
  }

  private recordEvent(
    change: ChangeSet,
    task: { id: string; project_id: string },
    actor: Actor,
    kind: EventKind,
    payload: Record<string, unknown>,
  ): void {
    this.db
      .prepare(
        `INSERT INTO task_events (task_id, actor, actor_thread_id, kind, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(task.id, actor.kind, actor.threadId, kind, JSON.stringify(payload), this.now());
    change.tasks.add(task.id);
    change.projects.add(task.project_id);
  }

  private touch(task: TaskRow, actor: Actor): void {
    this.db
      .prepare(`UPDATE tasks SET updated_at = ?, updated_by = ? WHERE id = ?`)
      .run(this.now(), actor.kind, task.id);
  }

  // ---------------------------------------------------------------------------
  // Lanes

  /**
   * The project's lanes, creating the default set the first time. Called only
   * when the user opens the project's board or a task is created there.
   */
  ensureLanes(projectId: string): LaneRow[] {
    const existing = this.laneRows(projectId);
    if (existing.length > 0) return existing;
    // Creating defaults is not a visible change: no reader has seen this
    // project's lanes yet, so it does not invalidate anything.
    return this.db.transaction(() => {
      const again = this.laneRows(projectId);
      if (again.length > 0) return again;
      let position: string | null = null;
      const insert = this.db.prepare(
        `INSERT INTO lanes (id, project_id, name, kind, position, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const lane of DEFAULT_LANES) {
        position = keyBetween(position, null);
        insert.run(newId("lan"), projectId, lane.name, lane.kind, position, this.now());
      }
      return this.laneRows(projectId);
    })();
  }

  private laneRows(projectId: string): LaneRow[] {
    return this.db
      .prepare(
        `SELECT id, project_id, name, kind, position FROM lanes WHERE project_id = ? ORDER BY position, id`,
      )
      .all(projectId) as LaneRow[];
  }

  private laneRow(laneId: string): LaneRow {
    const row = this.db
      .prepare(`SELECT id, project_id, name, kind, position FROM lanes WHERE id = ?`)
      .get(laneId) as LaneRow | undefined;
    if (!row) throw new StoreError("not_found", `No lane ${laneId}`);
    return row;
  }

  /** The project's lanes; empty until its board is opened or a task created. */
  lanes(projectId: string): Lane[] {
    const rows = this.laneRows(projectId);
    const counts = new Map(
      (
        this.db
          .prepare(
            `SELECT lane_id, count(*) AS n FROM tasks WHERE project_id = ? AND archived_at IS NULL GROUP BY lane_id`,
          )
          .all(projectId) as Array<{ lane_id: string; n: number }>
      ).map((row) => [row.lane_id, row.n]),
    );
    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      kind: row.kind,
      position: row.position,
      taskCount: counts.get(row.id) ?? 0,
    }));
  }

  /** Resolve a lane by id, name (any case) or kind, in board order. */
  findLane(projectId: string, reference: string): LaneRow | null {
    const lanes = this.laneRows(projectId);
    const wanted = reference.trim().toLowerCase();
    const byId = lanes.find((lane) => lane.id === reference.trim());
    if (byId) return byId;
    const byName = lanes.find((lane) => lane.name.toLowerCase() === wanted);
    if (byName) return byName;
    const kind = LANE_ALIASES[wanted.replace(/[\s_-]+/gu, " ")];
    if (kind) return lanes.find((lane) => lane.kind === kind) ?? null;
    return null;
  }

  createLane(
    input: { projectId: string; name: string; kind: LaneKind; afterLaneId?: string | null; id?: string },
  ): Lane {
    return this.commit((change) => {
      const lanes = this.ensureLanes(input.projectId);
      if (lanes.length >= 12) throw new StoreError("invalid", "A board has at most 12 lanes");
      const id = input.id ?? newId("lan");
      if (this.db.prepare(`SELECT 1 FROM lanes WHERE id = ?`).get(id)) {
        throw new StoreError("conflict", `Lane ${id} already exists`);
      }
      const position = this.lanePosition(lanes, input.afterLaneId ?? null, id);
      this.db
        .prepare(
          `INSERT INTO lanes (id, project_id, name, kind, position, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(id, input.projectId, input.name, input.kind, position, this.now());
      change.projects.add(input.projectId);
      return this.lanes(input.projectId).find((lane) => lane.id === id)!;
    });
  }

  updateLane(laneId: string, patch: { name?: string; kind?: LaneKind }): Lane {
    return this.commit((change) => {
      const lane = this.laneRow(laneId);
      this.db
        .prepare(`UPDATE lanes SET name = ?, kind = ? WHERE id = ?`)
        .run(patch.name ?? lane.name, patch.kind ?? lane.kind, laneId);
      change.projects.add(lane.project_id);
      return this.lanes(lane.project_id).find((row) => row.id === laneId)!;
    });
  }

  moveLane(laneId: string, afterLaneId: string | null): Lane {
    return this.commit((change) => {
      const lane = this.laneRow(laneId);
      const others = this.laneRows(lane.project_id).filter((row) => row.id !== laneId);
      const position = this.lanePosition(others, afterLaneId, laneId);
      this.db.prepare(`UPDATE lanes SET position = ? WHERE id = ?`).run(position, laneId);
      change.projects.add(lane.project_id);
      return this.lanes(lane.project_id).find((row) => row.id === laneId)!;
    });
  }

  /** Delete a lane; its tasks move to `moveTasksTo` (required when it has any). */
  deleteLane(laneId: string, moveTasksTo: string | null, actor: Actor): void {
    this.commit((change) => {
      const lane = this.laneRow(laneId);
      const lanes = this.laneRows(lane.project_id);
      if (lanes.length <= 1) throw new StoreError("invalid", "A board needs at least one lane");
      const tasks = this.db
        .prepare(`SELECT * FROM tasks WHERE lane_id = ? ORDER BY position, id`)
        .all(laneId) as TaskRow[];
      if (tasks.length > 0) {
        if (!moveTasksTo) {
          throw new StoreError(
            "conflict",
            `Lane "${lane.name}" has ${tasks.length} task(s); choose a lane to move them to`,
          );
        }
        const target = this.laneRow(moveTasksTo);
        if (target.project_id !== lane.project_id || target.id === lane.id) {
          throw new StoreError("invalid", "Move tasks to another lane on the same board");
        }
        for (const task of tasks) {
          this.placeTask(task, target, { laneId: target.id, placement: "bottom" });
          this.touch(task, actor);
          this.recordEvent(change, task, actor, "moved", {
            fromLaneId: lane.id,
            fromLaneName: lane.name,
            toLaneId: target.id,
            toLaneName: target.name,
          });
        }
      }
      this.db.prepare(`DELETE FROM lanes WHERE id = ?`).run(laneId);
      change.projects.add(lane.project_id);
    });
  }

  private lanePosition(lanes: LaneRow[], afterLaneId: string | null, selfId: string): string {
    const ordered = lanes.filter((lane) => lane.id !== selfId);
    if (afterLaneId === null) {
      return keyBetween(null, ordered[0]?.position ?? null);
    }
    const index = ordered.findIndex((lane) => lane.id === afterLaneId);
    if (index < 0) throw new StoreError("not_found", `No lane ${afterLaneId} on this board`);
    return keyBetween(ordered[index]!.position, ordered[index + 1]?.position ?? null);
  }

  // ---------------------------------------------------------------------------
  // Tasks: writes

  createTask(input: CreateTaskInput, actor: Actor): TaskCard {
    return this.commit((change) => {
      const lanes = this.ensureLanes(input.projectId);
      const lane = input.laneId ? this.laneRow(input.laneId) : lanes[0]!;
      if (lane.project_id !== input.projectId) {
        throw new StoreError("invalid", "That lane belongs to another project");
      }
      const id = input.id ?? newId("tsk");
      if (this.db.prepare(`SELECT 1 FROM tasks WHERE id = ?`).get(id)) {
        throw new StoreError("conflict", `Task ${id} already exists`);
      }
      const now = this.now();
      const ref = input.externalRef ?? null;
      const position = this.edgePosition(lane.id, input.placement ?? "bottom", null);
      this.db
        .prepare(
          `INSERT INTO tasks (id, project_id, title, body, lane_id, position, priority, labels,
             external_ref, external_key, created_at, updated_at, updated_by, archived_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          id,
          input.projectId,
          input.title,
          input.body ?? "",
          lane.id,
          position,
          input.priority ?? "none",
          JSON.stringify(input.labels ?? []),
          ref === null ? null : JSON.stringify(ref),
          externalKey(ref),
          now,
          now,
          actor.kind,
        );
      this.recordEvent(change, { id, project_id: input.projectId }, actor, "created", {
        laneId: lane.id,
        laneName: lane.name,
        ...(input.via ? { via: input.via } : {}),
      });
      return this.card(id)!;
    });
  }

  /** The oldest open task carrying `ref`, in one project or (null) any. */
  findByExternalRef(projectId: string | null, ref: ExternalRef): string | null {
    const row = this.db
      .prepare(
        `SELECT id FROM tasks WHERE (? IS NULL OR project_id = ?) AND external_key = ? AND archived_at IS NULL
         ORDER BY created_at LIMIT 1`,
      )
      .get(projectId, projectId, externalKey(ref)) as { id: string } | undefined;
    return row?.id ?? null;
  }

  updateTask(taskId: string, patch: UpdateTaskInput, actor: Actor): TaskCard {
    return this.commit((change) => {
      const task = this.taskRow(taskId);
      const fields: string[] = [];
      const next = {
        title: patch.title ?? task.title,
        body: patch.body ?? task.body,
        priority: patch.priority ?? task.priority,
        labels: patch.labels ? JSON.stringify(patch.labels) : task.labels,
        external_ref:
          patch.externalRef === undefined
            ? task.external_ref
            : patch.externalRef === null
              ? null
              : JSON.stringify(patch.externalRef),
      };
      if (next.title !== task.title) fields.push("title");
      if (next.body !== task.body) fields.push("body");
      if (next.priority !== task.priority) fields.push("priority");
      if (next.labels !== task.labels) fields.push("labels");
      if (next.external_ref !== task.external_ref) fields.push("externalRef");
      if (fields.length === 0) return this.card(taskId)!;
      this.db
        .prepare(
          `UPDATE tasks SET title = ?, body = ?, priority = ?, labels = ?, external_ref = ?, external_key = ?
           WHERE id = ?`,
        )
        .run(
          next.title,
          next.body,
          next.priority,
          next.labels,
          next.external_ref,
          next.external_ref === null ? null : externalKey(JSON.parse(next.external_ref) as ExternalRef),
          taskId,
        );
      this.touch(task, actor);
      const payload: Record<string, unknown> = { fields };
      if (fields.includes("title")) payload.title = { from: task.title, to: next.title };
      if (fields.includes("priority")) payload.priority = { from: task.priority, to: next.priority };
      this.recordEvent(change, task, actor, "updated", payload);
      return this.card(taskId)!;
    });
  }

  /**
   * Move a task to a lane and a place in it.
   *
   * Callers name neighbours from their own (possibly stale) view. The anchor is
   * re-read inside the transaction: "after X" lands directly after X wherever
   * X is now, between X and whatever follows X now. An anchor that left the
   * lane is ignored in favour of the other one, then `placement`. Only the
   * moved row changes.
   */
  moveTask(taskId: string, input: MoveTaskInput, actor: Actor): TaskCard {
    return this.commit((change) => {
      const task = this.taskRow(taskId);
      const lane = this.laneRow(input.laneId);
      if (lane.project_id !== task.project_id) {
        throw new StoreError("invalid", "Tasks move only between lanes of their own board");
      }
      const fromLane = this.laneRow(task.lane_id);
      const before = task.position;
      this.placeTask(task, lane, input);
      const after = this.taskRow(taskId);
      if (after.lane_id === task.lane_id && after.position === before) {
        return this.card(taskId)!;
      }
      this.touch(task, actor);
      if (lane.id !== fromLane.id) {
        this.recordEvent(change, task, actor, "moved", {
          fromLaneId: fromLane.id,
          fromLaneName: fromLane.name,
          toLaneId: lane.id,
          toLaneName: lane.name,
        });
      } else {
        // Reordering within a lane is not activity worth a row, but readers
        // still need to refresh.
        change.tasks.add(task.id);
        change.projects.add(task.project_id);
      }
      return this.card(taskId)!;
    });
  }

  private placeTask(task: TaskRow, lane: LaneRow, input: MoveTaskInput): void {
    const position = this.anchoredPosition(task.id, lane.id, input);
    this.db
      .prepare(`UPDATE tasks SET lane_id = ?, position = ? WHERE id = ?`)
      .run(lane.id, position, task.id);
  }

  private anchoredPosition(taskId: string, laneId: string, input: MoveTaskInput): string {
    const anchor = (id: string | null | undefined): TaskRow | null => {
      if (!id || id === taskId) return null;
      const row = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as TaskRow | undefined;
      return row && row.lane_id === laneId && row.archived_at === null ? row : null;
    };
    const after = anchor(input.afterTaskId);
    if (after) {
      const next = this.neighbour(laneId, after, "next", taskId);
      return this.between(after.position, next?.position ?? null);
    }
    const before = anchor(input.beforeTaskId);
    if (before) {
      const previous = this.neighbour(laneId, before, "previous", taskId);
      return this.between(previous?.position ?? null, before.position);
    }
    return this.edgePosition(laneId, input.placement ?? "bottom", taskId);
  }

  private neighbour(
    laneId: string,
    of: TaskRow,
    direction: "next" | "previous",
    excludeId: string,
  ): TaskRow | null {
    const sql =
      direction === "next"
        ? `SELECT * FROM tasks WHERE lane_id = ? AND archived_at IS NULL AND id != ?
             AND (position > ? OR (position = ? AND id > ?)) ORDER BY position, id LIMIT 1`
        : `SELECT * FROM tasks WHERE lane_id = ? AND archived_at IS NULL AND id != ?
             AND (position < ? OR (position = ? AND id < ?)) ORDER BY position DESC, id DESC LIMIT 1`;
    return (
      (this.db.prepare(sql).get(laneId, excludeId, of.position, of.position, of.id) as
        | TaskRow
        | undefined) ?? null
    );
  }

  private edgePosition(laneId: string, placement: "top" | "bottom", excludeId: string | null): string {
    const sql =
      placement === "top"
        ? `SELECT position FROM tasks WHERE lane_id = ? AND archived_at IS NULL AND id != ? ORDER BY position, id LIMIT 1`
        : `SELECT position FROM tasks WHERE lane_id = ? AND archived_at IS NULL AND id != ? ORDER BY position DESC, id DESC LIMIT 1`;
    const edge = this.db.prepare(sql).get(laneId, excludeId ?? "") as { position: string } | undefined;
    if (!edge) return keyBetween(null, null);
    return placement === "top" ? keyBetween(null, edge.position) : keyBetween(edge.position, null);
  }

  /** keyBetween that tolerates equal neighbours (never produced here, but imported data could). */
  private between(low: string | null, high: string | null): string {
    if (low !== null && high !== null && low >= high) return keyBetween(low, null);
    return keyBetween(low, high);
  }

  setArchived(taskId: string, archived: boolean, actor: Actor): TaskCard {
    return this.commit((change) => {
      const task = this.taskRow(taskId);
      if ((task.archived_at !== null) === archived) return this.card(taskId)!;
      if (archived) {
        this.db.prepare(`UPDATE tasks SET archived_at = ? WHERE id = ?`).run(this.now(), taskId);
      } else {
        // Back at the bottom of its lane, so it does not land between keys
        // that were issued while it was away.
        const position = this.edgePosition(task.lane_id, "bottom", taskId);
        this.db
          .prepare(`UPDATE tasks SET archived_at = NULL, position = ? WHERE id = ?`)
          .run(position, taskId);
      }
      this.touch(task, actor);
      this.recordEvent(change, task, actor, archived ? "archived" : "unarchived", {});
      return this.card(taskId)!;
    });
  }

  /** Delete a task with its links and activity. Returns the unlinked thread ids. */
  deleteTask(taskId: string): string[] {
    return this.commit((change) => {
      const task = this.taskRow(taskId);
      const threads = this.threadIdsFor(taskId);
      this.db.prepare(`DELETE FROM task_events WHERE task_id = ?`).run(taskId);
      this.db.prepare(`DELETE FROM task_threads WHERE task_id = ?`).run(taskId);
      this.db.prepare(`DELETE FROM tasks WHERE id = ?`).run(taskId);
      change.tasks.add(taskId);
      change.projects.add(task.project_id);
      for (const threadId of threads) change.threads.add(threadId);
      return threads;
    });
  }

  addComment(taskId: string, body: string, actor: Actor): TaskEvent {
    return this.commit((change) => {
      const task = this.taskRow(taskId);
      this.touch(task, actor);
      this.recordEvent(change, task, actor, "commented", { body });
      const row = this.db
        .prepare(`SELECT * FROM task_events WHERE task_id = ? ORDER BY id DESC LIMIT 1`)
        .get(taskId) as EventRow;
      return eventFromRow(row);
    });
  }

  // ---------------------------------------------------------------------------
  // Thread links. A thread works on at most one task; a task can have many
  // threads. The table is the source of truth; thread metadata mirrors it.

  /**
   * Link a thread to a task, moving it off any task it was on. Returns the
   * task it left, or null.
   */
  linkThread(taskId: string, threadId: string, actor: Actor): { previousTaskId: string | null; changed: boolean } {
    return this.commit((change) => this.linkThreadIn(change, taskId, threadId, actor));
  }

  private linkThreadIn(
    change: ChangeSet,
    taskId: string,
    threadId: string,
    actor: Actor,
  ): { previousTaskId: string | null; changed: boolean } {
    {
      const task = this.taskRow(taskId);
      const current = this.db
        .prepare(`SELECT task_id FROM task_threads WHERE thread_id = ?`)
        .get(threadId) as { task_id: string } | undefined;
      if (current?.task_id === taskId) return { previousTaskId: null, changed: false };
      if (current) {
        const previous = this.taskRow(current.task_id);
        this.db.prepare(`DELETE FROM task_threads WHERE thread_id = ?`).run(threadId);
        this.recordEvent(change, previous, actor, "unlinked", { threadId, movedToTaskId: taskId });
      }
      this.db
        .prepare(`INSERT INTO task_threads (task_id, thread_id, linked_at) VALUES (?, ?, ?)`)
        .run(taskId, threadId, this.now());
      this.recordEvent(change, task, actor, "linked", { threadId });
      change.threads.add(threadId);
      return { previousTaskId: current?.task_id ?? null, changed: true };
    }
  }

  /**
   * "Start work": link the thread and, when the task is still in a to-do lane,
   * move it to the first doing lane. One commit, one refresh.
   */
  startWork(taskId: string, threadId: string, actor: Actor): { moved: boolean } {
    return this.commit((change) => {
      this.linkThreadIn(change, taskId, threadId, actor);
      const task = this.taskRow(taskId);
      const from = this.laneRow(task.lane_id);
      if (from.kind !== "todo" || task.archived_at !== null) return { moved: false };
      const doing = this.laneRows(task.project_id).find((lane) => lane.kind === "doing");
      if (!doing) return { moved: false };
      this.placeTask(task, doing, { laneId: doing.id, placement: "top" });
      this.touch(task, actor);
      this.recordEvent(change, task, actor, "moved", {
        fromLaneId: from.id,
        fromLaneName: from.name,
        toLaneId: doing.id,
        toLaneName: doing.name,
        reason: "start-work",
      });
      return { moved: true };
    });
  }

  /** Remove a thread's link. `reason` is recorded, e.g. "deleted". */
  unlinkThread(threadId: string, actor: Actor, reason?: string): string | null {
    return this.commit((change) => {
      const current = this.db
        .prepare(`SELECT task_id FROM task_threads WHERE thread_id = ?`)
        .get(threadId) as { task_id: string } | undefined;
      if (!current) return null;
      const task = this.taskRow(current.task_id);
      this.db.prepare(`DELETE FROM task_threads WHERE thread_id = ?`).run(threadId);
      this.recordEvent(change, task, actor, "unlinked", { threadId, ...(reason ? { reason } : {}) });
      change.threads.add(threadId);
      return task.id;
    });
  }

  taskIdForThread(threadId: string): string | null {
    const row = this.db
      .prepare(`SELECT task_id FROM task_threads WHERE thread_id = ?`)
      .get(threadId) as { task_id: string } | undefined;
    return row?.task_id ?? null;
  }

  allLinkedThreadIds(): string[] {
    return (
      this.db.prepare(`SELECT thread_id FROM task_threads`).all() as Array<{ thread_id: string }>
    ).map((row) => row.thread_id);
  }

  private threadIdsFor(taskId: string): string[] {
    return (
      this.db
        .prepare(`SELECT thread_id FROM task_threads WHERE task_id = ? ORDER BY linked_at, thread_id`)
        .all(taskId) as Array<{ thread_id: string }>
    ).map((row) => row.thread_id);
  }

  // ---------------------------------------------------------------------------
  // Tasks: reads

  private taskRow(taskId: string): TaskRow {
    const row = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as TaskRow | undefined;
    if (!row) throw new StoreError("not_found", `No task ${taskId}`);
    return row;
  }

  exists(taskId: string): boolean {
    return this.db.prepare(`SELECT 1 FROM tasks WHERE id = ?`).get(taskId) !== undefined;
  }

  projectOf(taskId: string): string | null {
    const row = this.db.prepare(`SELECT project_id FROM tasks WHERE id = ?`).get(taskId) as
      | { project_id: string }
      | undefined;
    return row?.project_id ?? null;
  }

  card(taskId: string): TaskCard | null {
    const row = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as TaskRow | undefined;
    if (!row) return null;
    return this.cards([row])[0]!;
  }

  private cards(rows: TaskRow[]): TaskCard[] {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const placeholders = ids.map(() => "?").join(",");
    const threads = new Map<string, string[]>();
    for (const link of this.db
      .prepare(
        `SELECT task_id, thread_id FROM task_threads WHERE task_id IN (${placeholders}) ORDER BY linked_at, thread_id`,
      )
      .all(...ids) as Array<{ task_id: string; thread_id: string }>) {
      const list = threads.get(link.task_id) ?? [];
      list.push(link.thread_id);
      threads.set(link.task_id, list);
    }
    const comments = new Map(
      (
        this.db
          .prepare(
            `SELECT task_id, count(*) AS n FROM task_events WHERE kind = 'commented' AND task_id IN (${placeholders}) GROUP BY task_id`,
          )
          .all(...ids) as Array<{ task_id: string; n: number }>
      ).map((row) => [row.task_id, row.n]),
    );
    const laneKinds = new Map(
      (
        this.db
          .prepare(`SELECT id, kind FROM lanes WHERE id IN (${rows.map(() => "?").join(",")})`)
          .all(...rows.map((row) => row.lane_id)) as Array<{ id: string; kind: LaneKind }>
      ).map((row) => [row.id, row.kind]),
    );
    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      laneId: row.lane_id,
      laneKind: laneKinds.get(row.lane_id) ?? "todo",
      position: row.position,
      title: row.title,
      preview: preview(row.body),
      priority: row.priority,
      labels: JSON.parse(row.labels) as string[],
      externalRef: row.external_ref === null ? null : (JSON.parse(row.external_ref) as ExternalRef),
      threadIds: threads.get(row.id) ?? [],
      commentCount: comments.get(row.id) ?? 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
      archivedAt: row.archived_at,
    }));
  }

  /**
   * The board: lanes in order and, per lane, up to `perLane` tasks in order.
   * `projectId` null reads every project's board.
   */
  board(
    projectIds: string[],
    options: { perLane: number; archived: boolean },
  ): { lanes: Lane[]; tasks: TaskCard[]; truncated: boolean } {
    const lanes: Lane[] = [];
    const rows: TaskRow[] = [];
    let truncated = false;
    for (const projectId of projectIds) {
      for (const lane of this.lanes(projectId)) {
        lanes.push(lane);
        const page = this.db
          .prepare(
            `SELECT * FROM tasks WHERE lane_id = ? AND ${options.archived ? "archived_at IS NOT NULL" : "archived_at IS NULL"}
             ORDER BY position, id LIMIT ?`,
          )
          .all(lane.id, options.perLane + 1) as TaskRow[];
        if (page.length > options.perLane) {
          truncated = true;
          page.length = options.perLane;
        }
        rows.push(...page);
      }
    }
    return { lanes, tasks: this.cards(rows), truncated };
  }

  /** Projects with at least one task, archived included: the all-projects view. */
  projectIdsWithBoards(): string[] {
    return (
      this.db.prepare(`SELECT DISTINCT project_id FROM tasks ORDER BY project_id`).all() as Array<{
        project_id: string;
      }>
    ).map((row) => row.project_id);
  }

  list(query: ListTasksQuery): { tasks: TaskCard[]; total: number } {
    const where: string[] = [query.archived ? "t.archived_at IS NOT NULL" : "t.archived_at IS NULL"];
    const params: unknown[] = [];
    if (query.projectId !== null) {
      where.push("t.project_id = ?");
      params.push(query.projectId);
    }
    if (query.laneId) {
      where.push("t.lane_id = ?");
      params.push(query.laneId);
    }
    if (query.query) {
      where.push("(t.title LIKE ? ESCAPE '\\' OR t.body LIKE ? ESCAPE '\\' OR t.id = ?)");
      const like = `%${query.query.replace(/[\\%_]/gu, (char) => `\\${char}`)}%`;
      params.push(like, like, query.query);
    }
    if (query.label) {
      where.push("EXISTS (SELECT 1 FROM json_each(t.labels) WHERE lower(json_each.value) = lower(?))");
      params.push(query.label);
    }
    const clause = where.join(" AND ");
    const total = (
      this.db
        .prepare(`SELECT count(*) AS n FROM tasks t WHERE ${clause}`)
        .get(...params) as { n: number }
    ).n;
    const rows = this.db
      .prepare(
        `SELECT t.* FROM tasks t JOIN lanes l ON l.id = t.lane_id WHERE ${clause}
         ORDER BY t.project_id, l.position, l.id, t.position, t.id LIMIT ? OFFSET ?`,
      )
      .all(...params, query.limit, query.offset) as TaskRow[];
    return { tasks: this.cards(rows), total };
  }

  detail(taskId: string, eventLimit: number): TaskDetail | null {
    const card = this.card(taskId);
    if (!card) return null;
    const row = this.taskRow(taskId);
    const lane = this.laneRow(row.lane_id);
    const links = this.db
      .prepare(`SELECT thread_id, linked_at FROM task_threads WHERE task_id = ? ORDER BY linked_at, thread_id`)
      .all(taskId) as Array<{ thread_id: string; linked_at: number }>;
    const page = this.events(taskId, null, eventLimit);
    return {
      ...card,
      body: row.body,
      laneName: lane.name,
      threads: links.map((link) => ({ threadId: link.thread_id, linkedAt: link.linked_at })),
      events: page.events,
      eventsCursor: page.cursor,
    };
  }

  /** Activity newest first, `before` an event id from a previous page. */
  events(taskId: string, before: number | null, limit: number): { events: TaskEvent[]; cursor: number | null } {
    const rows = this.db
      .prepare(
        `SELECT * FROM task_events WHERE task_id = ? AND id < ? ORDER BY id DESC LIMIT ?`,
      )
      .all(taskId, before ?? Number.MAX_SAFE_INTEGER, limit + 1) as EventRow[];
    const more = rows.length > limit;
    if (more) rows.length = limit;
    // The cursor is the oldest event shown; with limit 0 nothing is shown, so
    // the next page starts from the newest.
    const cursor = more ? (rows.at(-1)?.id ?? Number.MAX_SAFE_INTEGER) : null;
    return { events: rows.map(eventFromRow), cursor };
  }

  /** Non-archived task counts per project and lane kind. */
  counts(): Array<{ projectId: string; kind: LaneKind; count: number }> {
    return (
      this.db
        .prepare(
          `SELECT t.project_id AS projectId, l.kind AS kind, count(*) AS count
           FROM tasks t JOIN lanes l ON l.id = t.lane_id
           WHERE t.archived_at IS NULL GROUP BY t.project_id, l.kind`,
        )
        .all() as Array<{ projectId: string; kind: LaneKind; count: number }>
    );
  }
}

const LANE_ALIASES: Record<string, LaneKind> = {
  todo: "todo",
  "to do": "todo",
  backlog: "todo",
  doing: "doing",
  "in progress": "doing",
  progress: "doing",
  wip: "doing",
  started: "doing",
  review: "review",
  "in review": "review",
  "needs review": "review",
  done: "done",
  complete: "done",
  completed: "done",
  closed: "done",
};

function eventFromRow(row: EventRow): TaskEvent {
  return {
    id: row.id,
    taskId: row.task_id,
    actor: row.actor,
    actorThreadId: row.actor_thread_id,
    kind: row.kind,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    createdAt: row.created_at,
  };
}
