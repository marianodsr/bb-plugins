// The one place surfaces call into. RPC handlers, CLI commands, agent tools and
// bb event handlers all use these methods, so validation, thread metadata and
// tag invalidation behave the same whoever writes.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { buildTaskPrompt } from "./prompt.js";
import { readStatuses, ThreadWatcher } from "./threads.js";
import {
  type Actor,
  type ChangeSet,
  type CreateTaskInput,
  MIGRATIONS,
  type MoveTaskInput,
  StoreError,
  SYSTEM,
  TaskStore,
  type UpdateTaskInput,
} from "./store.js";
import {
  type ExternalRef,
  type Lane,
  type LaneKind,
  type TaskCard,
  type TaskDetail,
  type ThreadStatusView,
  taskIdSchema,
} from "./schemas.js";

export const LAST_PROJECT_KEY = "lastProjectId";
export const METADATA_TASK_KEY = "taskId";

export function boardTag(projectId: string | null): string {
  return projectId === null ? "board:all" : `board:${projectId}`;
}
export function taskTag(taskId: string): string {
  return `task:${taskId}`;
}
export function threadTaskTag(threadId: string): string {
  return `threadTask:${threadId}`;
}
export const SUMMARY_TAG = "summary";

/** Tags a commit invalidates. One call per commit, so each read refreshes once. */
export function tagsFor(change: ChangeSet): string[] {
  const tags = new Set<string>();
  if (change.projects.size > 0) {
    tags.add(boardTag(null));
    tags.add(SUMMARY_TAG);
  }
  for (const projectId of change.projects) tags.add(boardTag(projectId));
  for (const taskId of change.tasks) tags.add(taskTag(taskId));
  for (const threadId of change.threads) tags.add(threadTaskTag(threadId));
  return [...tags];
}

/** Thread metadata is writable by anyone: accept only a well-formed task id. */
const metadataSchema = z.object({ taskId: taskIdSchema }).passthrough();

export function metadataTaskId(metadata: unknown): string | null {
  const parsed = metadataSchema.safeParse(metadata);
  return parsed.success ? parsed.data.taskId : null;
}

export interface BoardView {
  projects: Array<{ id: string; name: string }>;
  lanes: Lane[];
  tasks: TaskCard[];
  truncated: boolean;
}

export class TaskService {
  readonly store: TaskStore;
  readonly watcher: ThreadWatcher;
  private readonly knownProjects = new Set<string>();

  constructor(private readonly bb: BbPluginApi) {
    const db = bb.storage.database();
    bb.storage.migrate(db, [...MIGRATIONS]);
    this.watcher = new ThreadWatcher(bb, (tags) => bb.rpc.experimental_invalidate(tags));
    this.store = new TaskStore(db, (change) => this.afterCommit(change));
    this.watcher.setLinked(this.store.allLinkedThreadIds());
  }

  private afterCommit(change: ChangeSet): void {
    for (const threadId of change.threads) {
      if (this.store.taskIdForThread(threadId) === null) this.watcher.remove(threadId);
      else this.watcher.add(threadId);
    }
    this.bb.rpc.experimental_invalidate(tagsFor(change));
  }

  // ---------------------------------------------------------------------------
  // Projects

  async requireProject(projectId: string): Promise<string> {
    if (this.knownProjects.has(projectId)) return projectId;
    try {
      await this.bb.sdk.projects.get({ projectId });
    } catch {
      throw new StoreError("not_found", `No project ${projectId}`);
    }
    this.knownProjects.add(projectId);
    return projectId;
  }

  private async rememberProject(projectId: string): Promise<void> {
    if ((await this.bb.storage.kv.get<string>(LAST_PROJECT_KEY)) !== projectId) {
      await this.bb.storage.kv.set(LAST_PROJECT_KEY, projectId);
    }
  }

  /**
   * The project for a create that names none (another plugin's createTask):
   * the board used most recently, else the first project in bb's order.
   */
  async defaultProjectId(): Promise<string> {
    const last = await this.bb.storage.kv.get<string>(LAST_PROJECT_KEY);
    if (typeof last === "string") {
      try {
        return await this.requireProject(last);
      } catch {
        // Fall through: that project is gone.
      }
    }
    const [first] = await this.bb.sdk.projects.list();
    if (!first) throw new StoreError("not_found", "There is no project to put the task in");
    return this.requireProject(first.id);
  }

  private async projectNames(projectIds: string[] | null): Promise<Array<{ id: string; name: string }>> {
    const projects = await this.bb.sdk.projects.list();
    const named = projects.map((project) => ({ id: project.id, name: project.name }));
    if (projectIds === null) return named;
    const wanted = new Set(projectIds);
    return named.filter((project) => wanted.has(project.id));
  }

  // ---------------------------------------------------------------------------
  // Reads

  async board(projectId: string | null, options: { perLane: number; archived: boolean }): Promise<BoardView> {
    if (projectId !== null) {
      await this.requireProject(projectId);
      await this.rememberProject(projectId);
      // Opening a board is what creates its lanes.
      this.store.ensureLanes(projectId);
      const projects = await this.projectNames([projectId]);
      return { projects, ...this.store.board([projectId], options) };
    }
    const projects = await this.projectNames(null);
    const withBoards = new Set(this.store.projectIdsWithBoards());
    const ids = projects.map((project) => project.id).filter((id) => withBoards.has(id));
    return {
      projects: projects.filter((project) => withBoards.has(project.id)),
      ...this.store.board(ids, options),
    };
  }

  task(taskId: string, eventLimit = 50): TaskDetail | null {
    return this.store.detail(taskId, eventLimit);
  }

  async threadStatuses(threadIds: readonly string[], signal?: AbortSignal): Promise<Record<string, ThreadStatusView>> {
    return readStatuses(this.bb, threadIds, signal);
  }

  summary(): { reviewCount: number; projects: Array<{ projectId: string; counts: Record<LaneKind, number> }> } {
    const byProject = new Map<string, Record<LaneKind, number>>();
    let reviewCount = 0;
    for (const row of this.store.counts()) {
      const counts = byProject.get(row.projectId) ?? { todo: 0, doing: 0, review: 0, done: 0 };
      counts[row.kind] += row.count;
      byProject.set(row.projectId, counts);
      if (row.kind === "review") reviewCount += row.count;
    }
    return {
      reviewCount,
      projects: [...byProject].map(([projectId, counts]) => ({ projectId, counts })),
    };
  }

  // ---------------------------------------------------------------------------
  // Writes

  async createTask(
    input: Omit<CreateTaskInput, "projectId"> & { projectId?: string; dedupeExternalRef?: boolean },
    actor: Actor,
  ): Promise<TaskCard> {
    if (input.dedupeExternalRef && input.externalRef) {
      // Without a project, a reference already on any board is that task.
      const existing = this.store.findByExternalRef(input.projectId ?? null, input.externalRef);
      if (existing) return this.store.card(existing)!;
    }
    const projectId = input.projectId
      ? await this.requireProject(input.projectId)
      : await this.defaultProjectId();
    if (input.projectId) await this.rememberProject(projectId);
    const { dedupeExternalRef: _ignored, ...rest } = input;
    return this.store.createTask({ ...rest, projectId }, actor);
  }

  updateTask(taskId: string, patch: UpdateTaskInput, actor: Actor): TaskCard {
    return this.store.updateTask(taskId, patch, actor);
  }

  moveTask(taskId: string, input: MoveTaskInput, actor: Actor): TaskCard {
    return this.store.moveTask(taskId, input, actor);
  }

  /** Move by a lane reference an agent or the CLI typed: id, name or kind. */
  moveTaskToLane(
    taskId: string,
    laneReference: string,
    placement: "top" | "bottom" | undefined,
    actor: Actor,
  ): TaskCard {
    const projectId = this.store.projectOf(taskId);
    if (projectId === null) throw new StoreError("not_found", `No task ${taskId}`);
    const lane = this.resolveLane(projectId, laneReference);
    return this.store.moveTask(taskId, { laneId: lane.id, ...(placement ? { placement } : {}) }, actor);
  }

  resolveLane(projectId: string, reference: string): { id: string; name: string; kind: LaneKind } {
    const lane = this.store.findLane(projectId, reference);
    if (!lane) {
      const names = this.store
        .lanes(projectId)
        .map((row) => `"${row.name}" (${row.kind})`)
        .join(", ");
      throw new StoreError("not_found", `No lane "${reference}". Lanes: ${names}`);
    }
    return lane;
  }

  setArchived(taskId: string, archived: boolean, actor: Actor): TaskCard {
    return this.store.setArchived(taskId, archived, actor);
  }

  async deleteTask(taskId: string): Promise<void> {
    const threads = this.store.deleteTask(taskId);
    await Promise.all(threads.map((threadId) => this.clearMetadata(threadId, taskId)));
  }

  addComment(taskId: string, body: string, actor: Actor) {
    return this.store.addComment(taskId, body, actor);
  }

  /** Link a thread the user handed the task to, and move a to-do card to doing. */
  async startWork(taskId: string, threadId: string, actor: Actor): Promise<{ moved: boolean }> {
    await this.requireLinkableThread(taskId, threadId);
    const before = this.store.taskIdForThread(threadId);
    const result = this.store.startWork(taskId, threadId, actor);
    if (before !== taskId) await this.writeMetadata(threadId, taskId);
    return result;
  }

  private async requireLinkableThread(taskId: string, threadId: string): Promise<void> {
    const projectId = this.store.projectOf(taskId);
    if (projectId === null) throw new StoreError("not_found", `No task ${taskId}`);
    let thread: { projectId: string; deletedAt: number | null };
    try {
      thread = await this.bb.sdk.threads.get({ threadId });
    } catch {
      throw new StoreError("not_found", `No thread ${threadId}`);
    }
    if (thread.deletedAt !== null) throw new StoreError("not_found", `Thread ${threadId} was deleted`);
    if (thread.projectId !== projectId) {
      throw new StoreError("invalid", "Link threads from the task's own project");
    }
  }

  /** Whether Jira Viewer is installed and running, for the Jira chip's link. */
  async integrations(): Promise<{ jiraViewer: boolean }> {
    const { plugins } = await this.bb.sdk.plugins.list();
    const jira = plugins.find((plugin) => plugin.id === "jira-viewer");
    return { jiraViewer: jira !== undefined && jira.enabled && jira.status === "running" };
  }

  async linkThread(taskId: string, threadId: string, actor: Actor): Promise<{ previousTaskId: string | null }> {
    await this.requireLinkableThread(taskId, threadId);
    const result = this.store.linkThread(taskId, threadId, actor);
    if (result.changed) await this.writeMetadata(threadId, taskId);
    return { previousTaskId: result.previousTaskId };
  }

  async unlinkThread(threadId: string, actor: Actor, expectedTaskId?: string): Promise<string | null> {
    const current = this.store.taskIdForThread(threadId);
    if (expectedTaskId !== undefined && current !== expectedTaskId) {
      throw new StoreError("not_found", `Thread ${threadId} is not linked to ${expectedTaskId}`);
    }
    const taskId = this.store.unlinkThread(threadId, actor);
    if (taskId) await this.clearMetadata(threadId, taskId);
    return taskId;
  }

  private async writeMetadata(threadId: string, taskId: string): Promise<void> {
    try {
      await this.bb.sdk.threads.updatePluginMetadata({ threadId, set: { [METADATA_TASK_KEY]: taskId } });
    } catch (error) {
      this.bb.log.warn(`could not write task metadata on ${threadId}: ${String(error)}`);
    }
  }

  private async clearMetadata(threadId: string, taskId: string): Promise<void> {
    try {
      const current = await this.bb.sdk.threads.getPluginMetadata({ threadId });
      if (metadataTaskId(current) === taskId) {
        await this.bb.sdk.threads.updatePluginMetadata({ threadId, remove: [METADATA_TASK_KEY] });
      }
    } catch {
      // The thread is gone; nothing to clear.
    }
  }

  // ---------------------------------------------------------------------------
  // Threads created elsewhere (the new-thread composer seeds metadata)

  /**
   * Adopt a link a thread's metadata asks for. Accepted only for an existing
   * task in the thread's own project, which is no more than the thread's agent
   * could do itself with `bb tasks link`.
   */
  adoptFromMetadata(threadId: string, threadProjectId: string, metadata: unknown): boolean {
    const taskId = metadataTaskId(metadata);
    if (taskId === null) return false;
    if (this.store.taskIdForThread(threadId) !== null) return false;
    if (this.store.projectOf(taskId) !== threadProjectId) return false;
    this.store.linkThread(taskId, threadId, SYSTEM);
    return true;
  }

  async onThreadCreated(thread: { id: string; projectId: string; originPluginId: string | null }): Promise<void> {
    // Seeding metadata attributes the thread to this plugin, so other threads
    // cannot carry a seed and need no lookup.
    if (thread.originPluginId !== this.bb.pluginId) return;
    const metadata = await this.bb.sdk.threads.getPluginMetadata({ threadId: thread.id });
    this.adoptFromMetadata(thread.id, thread.projectId, metadata);
  }

  onThreadDeleted(threadId: string): void {
    if (this.store.taskIdForThread(threadId) === null) return;
    this.store.unlinkThread(threadId, SYSTEM, "deleted");
  }

  /**
   * Catch up after a restart, reload or disabled period: drop links to deleted
   * threads and adopt seeded links whose creation event was missed.
   */
  async reconcile(): Promise<void> {
    const linked = this.store.allLinkedThreadIds();
    if (linked.length > 0) {
      const statuses = await this.threadStatuses(linked);
      for (const [threadId, status] of Object.entries(statuses)) {
        if (status.state === "missing") this.store.unlinkThread(threadId, SYSTEM, "deleted");
      }
    }
    const PAGE = 200;
    for (let offset = 0; offset < 2_000; offset += PAGE) {
      const threads = await this.bb.sdk.threads.list({
        originPluginId: this.bb.pluginId,
        includeHidden: true,
        limit: PAGE,
        offset,
      });
      const unlinked = threads.filter((thread) => this.store.taskIdForThread(thread.id) === null);
      if (unlinked.length > 0) {
        const { threads: rows } = await this.bb.sdk.threads.experimental_listPluginMetadata({
          threadIds: unlinked.map((thread) => thread.id),
        });
        const projectOf = new Map(unlinked.map((thread) => [thread.id, thread.projectId]));
        for (const row of rows) {
          this.adoptFromMetadata(row.threadId, projectOf.get(row.threadId)!, row.metadata);
        }
      }
      if (threads.length < PAGE) break;
    }
  }

  // ---------------------------------------------------------------------------
  // Handoff

  /** The prompt a "Start work" handoff sends, and the metadata to seed. */
  taskPrompt(taskId: string): { prompt: string; pluginMetadata: { taskId: string } } {
    const task = this.store.detail(taskId, 0);
    if (!task) throw new StoreError("not_found", `No task ${taskId}`);
    return { prompt: buildTaskPrompt(task), pluginMetadata: { taskId: task.id } };
  }
}

export type { ExternalRef };
