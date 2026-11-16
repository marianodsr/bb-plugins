// Wire shapes shared by the RPC contract, the CLI and the agent tools.
import { z } from "zod";

export const TITLE_MAX = 200;
export const BODY_MAX = 50_000;
export const COMMENT_MAX = 10_000;
export const LABEL_MAX = 32;
export const LABELS_MAX = 10;
export const LANE_NAME_MAX = 40;
export const LANES_MAX = 12;

export const taskIdSchema = z
  .string()
  .regex(/^tsk_[a-z0-9]{10}$/u, "Task ids look like tsk_ followed by 10 letters or digits");
export const laneIdSchema = z
  .string()
  .regex(/^lan_[a-z0-9]{10}$/u, "Lane ids look like lan_ followed by 10 letters or digits");
export const threadIdSchema = z
  .string()
  .regex(/^thr_[A-Za-z0-9]{1,64}$/u, "Thread ids look like thr_…");
export const projectIdSchema = z
  .string()
  .regex(/^proj_[A-Za-z0-9]{1,64}$/u, "Project ids look like proj_…");

export const laneKindSchema = z.enum(["todo", "doing", "review", "done"]);
export type LaneKind = z.infer<typeof laneKindSchema>;

export const PRIORITIES = ["none", "low", "medium", "high", "urgent"] as const;
export const prioritySchema = z.enum(PRIORITIES);
export type Priority = z.infer<typeof prioritySchema>;

export const titleSchema = z.string().trim().min(1, "Title is empty").max(TITLE_MAX);
export const bodySchema = z.string().max(BODY_MAX);
export const labelsSchema = z
  .array(z.string().trim().min(1).max(LABEL_MAX))
  .max(LABELS_MAX)
  .transform((labels) => [...new Set(labels)]);

/** Cross-plugin contract: a task's link to an issue in another system. */
export const externalRefSchema = z
  .object({
    kind: z.literal("jira"),
    key: z.string().regex(/^[A-Z][A-Z0-9_]{0,31}-[1-9][0-9]{0,9}$/u, "Expected a Jira key such as ENG-42"),
    url: z
      .string()
      .max(2048)
      .url()
      .refine((value) => value.startsWith("https://"), "Expected an https URL"),
  })
  .strict();
export type ExternalRef = z.infer<typeof externalRefSchema>;

export const actorSchema = z.enum(["user", "agent", "system"]);
export type ActorKind = z.infer<typeof actorSchema>;

export const laneSchema = z.object({
  id: laneIdSchema,
  projectId: z.string(),
  name: z.string(),
  kind: laneKindSchema,
  position: z.string(),
  /** Non-archived tasks in the lane, including any beyond the page. */
  taskCount: z.number().int(),
});
export type Lane = z.infer<typeof laneSchema>;

export const taskCardSchema = z.object({
  id: taskIdSchema,
  projectId: z.string(),
  laneId: laneIdSchema,
  laneKind: laneKindSchema,
  position: z.string(),
  title: z.string(),
  /** First 200 characters of the body, whitespace collapsed. */
  preview: z.string(),
  priority: prioritySchema,
  labels: z.array(z.string()),
  externalRef: externalRefSchema.nullable(),
  /** Linked thread ids, oldest link first. Status comes from threadStatuses. */
  threadIds: z.array(z.string()),
  commentCount: z.number().int(),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** Who made the latest change, so the UI can tell agent moves apart. */
  updatedBy: actorSchema,
  archivedAt: z.number().nullable(),
});
export type TaskCard = z.infer<typeof taskCardSchema>;

export const eventKindSchema = z.enum([
  "created",
  "updated",
  "moved",
  "commented",
  "linked",
  "unlinked",
  "archived",
  "unarchived",
]);
export type EventKind = z.infer<typeof eventKindSchema>;

export const taskEventSchema = z.object({
  id: z.number().int(),
  taskId: z.string(),
  actor: actorSchema,
  /** The agent's thread for actor "agent"; null otherwise. */
  actorThreadId: z.string().nullable(),
  kind: eventKindSchema,
  /** Kind-specific JSON: comment { body }, moved { fromLaneId, toLaneId, fromLaneName, toLaneName }, … */
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.number(),
});
export type TaskEvent = z.infer<typeof taskEventSchema>;

export const taskDetailSchema = taskCardSchema.extend({
  body: z.string(),
  laneName: z.string(),
  threads: z.array(z.object({ threadId: z.string(), linkedAt: z.number() })),
  /** Newest first. */
  events: z.array(taskEventSchema),
  /** Pass as `before` to taskEvents for older activity; null when complete. */
  eventsCursor: z.number().int().nullable(),
});
export type TaskDetail = z.infer<typeof taskDetailSchema>;

/**
 * A linked thread as the board shows it. `state` folds bb's status fields
 * into the four the kit's StatusDot draws, plus archived and missing.
 */
export const threadStateSchema = z.enum([
  "running",
  "waiting",
  "idle",
  "failed",
  "archived",
  "missing",
]);
export type ThreadState = z.infer<typeof threadStateSchema>;

export const threadStatusSchema = z.object({
  threadId: z.string(),
  state: threadStateSchema,
  title: z.string().nullable(),
  projectId: z.string().nullable(),
  /** bb's raw status, for detail views; null when the thread is missing. */
  status: z.string().nullable(),
  displayStatus: z.string().nullable(),
  hasPendingInteraction: z.boolean(),
  archivedAt: z.number().nullable(),
  updatedAt: z.number().nullable(),
});
export type ThreadStatusView = z.infer<typeof threadStatusSchema>;
