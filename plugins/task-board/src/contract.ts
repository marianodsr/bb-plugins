// The RPC contract. app.tsx imports this file's type only.
//
// Reads declare tags; the server invalidates them after every write (see
// TaskService.afterCommit), so writes here declare nothing.
//
//   board:<projectId>     one project's board        board:all  every board
//   task:<taskId>         one task's detail
//   thread:<threadId>     one linked thread's status (keyed read)
//   threadTask:<threadId> which task a thread works on
//   summary               counts for the nav badge
//   integrations          companion plugins running
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  bodySchema,
  COMMENT_MAX,
  externalRefSchema,
  LANE_NAME_MAX,
  laneIdSchema,
  laneKindSchema,
  laneSchema,
  labelsSchema,
  prioritySchema,
  projectIdSchema,
  taskCardSchema,
  taskDetailSchema,
  taskEventSchema,
  taskIdSchema,
  threadIdSchema,
  threadStatusSchema,
  titleSchema,
} from "./schemas.js";

const boardOutput = z.object({
  projects: z.array(z.object({ id: z.string(), name: z.string() })),
  /** In board order; for all projects, grouped by project. */
  lanes: z.array(laneSchema),
  /** Ordered by lane, then position. */
  tasks: z.array(taskCardSchema),
  /** Some lane had more than `perLane` tasks; see lane.taskCount. */
  truncated: z.boolean(),
});

const anchorSchema = taskIdSchema.nullable().optional();

export const rpcContract = defineRpcContract({
  // ---- Reads ---------------------------------------------------------------
  board: {
    experimental_description: "One project's board, or every board when projectId is null.",
    input: z
      .object({
        projectId: projectIdSchema.nullable(),
        perLane: z.number().int().min(1).max(500).default(200),
        archived: z.boolean().default(false),
      })
      .strict(),
    output: boardOutput,
    tags: ({ projectId }) => [projectId === null ? "board:all" : `board:${projectId}`],
  },
  task: {
    experimental_description: "A task with its body, linked threads and latest activity; null once deleted.",
    input: z.object({ taskId: taskIdSchema, eventLimit: z.number().int().min(0).max(200).default(50) }).strict(),
    output: z.object({ task: taskDetailSchema.nullable() }),
    tags: ({ taskId }) => [`task:${taskId}`],
  },
  taskEvents: {
    experimental_description: "Older activity for a task, newest first, before an event id.",
    input: z
      .object({
        taskId: taskIdSchema,
        before: z.number().int().nullable(),
        limit: z.number().int().min(1).max(200).default(50),
      })
      .strict(),
    output: z.object({ events: z.array(taskEventSchema), cursor: z.number().int().nullable() }),
    tags: ({ taskId }) => [`task:${taskId}`],
  },
  threadStatuses: {
    experimental_description: "Live status of linked threads, keyed by thread id, read from bb.",
    input: z.object({ keys: z.array(z.string().min(1).max(80)).max(200) }).strict(),
    output: z.record(z.string(), threadStatusSchema),
    keyTags: (threadId) => [`thread:${threadId}`],
  },
  taskForThread: {
    experimental_description: "The task a thread works on, or null.",
    input: z.object({ threadId: threadIdSchema }).strict(),
    output: z.object({ task: taskCardSchema.nullable() }),
    tags: ({ threadId }, { task }) => [`threadTask:${threadId}`, ...(task ? [`task:${task.id}`] : [])],
  },
  summary: {
    experimental_description: "Task counts per project and lane kind; reviewCount feeds the nav badge.",
    input: z.null(),
    output: z.object({
      reviewCount: z.number().int(),
      projects: z.array(
        z.object({
          projectId: z.string(),
          counts: z.object({
            todo: z.number().int(),
            doing: z.number().int(),
            review: z.number().int(),
            done: z.number().int(),
          }),
        }),
      ),
    }),
    tags: () => ["summary"],
  },
  integrations: {
    experimental_description: "Which companion plugins are running (Jira Viewer for the Jira chip).",
    input: z.null(),
    output: z.object({ jiraViewer: z.boolean() }),
    tags: () => ["integrations"],
  },
  taskPrompt: {
    experimental_description: "Prompt text and plugin metadata for handing a task to a thread.",
    input: z.object({ taskId: taskIdSchema }).strict(),
    output: z.object({ prompt: z.string(), pluginMetadata: z.object({ taskId: z.string() }) }),
  },

  // ---- Writes --------------------------------------------------------------
  /**
   * Cross-plugin contract (PLAN.md): createTask({ title, body?, projectId?,
   * externalRef? }) → { id }. With externalRef, an open task already carrying
   * the same reference in that project is returned instead of a duplicate.
   * The app may also pass a client-generated id and placement fields.
   */
  createTask: {
    input: z
      .object({
        title: titleSchema,
        body: bodySchema.optional(),
        projectId: projectIdSchema.optional(),
        externalRef: externalRefSchema.optional(),
        id: taskIdSchema.optional(),
        laneId: laneIdSchema.optional(),
        placement: z.enum(["top", "bottom"]).optional(),
        priority: prioritySchema.optional(),
        labels: labelsSchema.optional(),
      })
      .strict(),
    output: z.object({ id: z.string() }),
  },
  updateTask: {
    input: z
      .object({
        taskId: taskIdSchema,
        title: titleSchema.optional(),
        body: bodySchema.optional(),
        priority: prioritySchema.optional(),
        labels: labelsSchema.optional(),
        externalRef: externalRefSchema.nullable().optional(),
      })
      .strict(),
    output: taskCardSchema,
  },
  /**
   * Drag and drop: name the neighbours from the client's view. "After" wins;
   * an anchor that has since left the lane is ignored. Without anchors the
   * task goes to `placement` (default bottom).
   */
  moveTask: {
    input: z
      .object({
        taskId: taskIdSchema,
        laneId: laneIdSchema,
        afterTaskId: anchorSchema,
        beforeTaskId: anchorSchema,
        placement: z.enum(["top", "bottom"]).optional(),
      })
      .strict(),
    output: taskCardSchema,
  },
  archiveTask: {
    input: z.object({ taskId: taskIdSchema, archived: z.boolean() }).strict(),
    output: taskCardSchema,
  },
  deleteTask: {
    input: z.object({ taskId: taskIdSchema }).strict(),
    output: z.object({ deleted: z.literal(true) }),
  },
  addComment: {
    input: z.object({ taskId: taskIdSchema, body: z.string().trim().min(1).max(COMMENT_MAX) }).strict(),
    output: taskEventSchema,
  },
  /**
   * Start work: after a handoff delivered the task to a thread, link it and
   * move a to-do card to the first doing lane, in one write.
   */
  startWork: {
    input: z.object({ taskId: taskIdSchema, threadId: threadIdSchema }).strict(),
    output: z.object({ moved: z.boolean() }),
  },
  linkThread: {
    input: z.object({ taskId: taskIdSchema, threadId: threadIdSchema }).strict(),
    output: z.object({ previousTaskId: z.string().nullable() }),
  },
  unlinkThread: {
    input: z.object({ taskId: taskIdSchema, threadId: threadIdSchema }).strict(),
    output: z.object({ unlinked: z.boolean() }),
  },
  createLane: {
    input: z
      .object({
        projectId: projectIdSchema,
        name: z.string().trim().min(1).max(LANE_NAME_MAX),
        kind: laneKindSchema,
        afterLaneId: laneIdSchema.nullable().optional(),
        id: laneIdSchema.optional(),
      })
      .strict(),
    output: laneSchema,
  },
  updateLane: {
    input: z
      .object({
        laneId: laneIdSchema,
        name: z.string().trim().min(1).max(LANE_NAME_MAX).optional(),
        kind: laneKindSchema.optional(),
      })
      .strict(),
    output: laneSchema,
  },
  moveLane: {
    input: z.object({ laneId: laneIdSchema, afterLaneId: laneIdSchema.nullable() }).strict(),
    output: laneSchema,
  },
  deleteLane: {
    input: z.object({ laneId: laneIdSchema, moveTasksTo: laneIdSchema.nullable().optional() }).strict(),
    output: z.object({ deleted: z.literal(true) }),
  },
});

export type RpcContract = typeof rpcContract;
