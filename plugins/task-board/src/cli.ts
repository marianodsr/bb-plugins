// `bb tasks`: the board from a shell, for users and agents in any thread.
import { cliCommand, defineCli, PluginCliError, type BbPluginApi, type PluginCliContext } from "@get-bb/plugin-sdk";
import { cardLine, detailView, lanesView, listView } from "./format.js";
import {
  BODY_MAX,
  COMMENT_MAX,
  LABEL_MAX,
  LABELS_MAX,
  PRIORITIES,
  TITLE_MAX,
  externalRefSchema,
  labelsSchema,
  projectIdSchema,
  taskIdSchema,
  threadIdSchema,
  titleSchema,
  type ExternalRef,
  type Priority,
} from "./schemas.js";
import type { TaskService } from "./service.js";
import { StoreError, USER, type Actor } from "./store.js";

export const CLI_NAME = "tasks";

function actorFor(ctx: PluginCliContext): Actor {
  // A command run from a thread's shell is that thread's agent at work.
  return ctx.threadId ? { kind: "agent", threadId: ctx.threadId } : USER;
}

function ok(stdout: string) {
  return { exitCode: 0, stdout: stdout.endsWith("\n") ? stdout : `${stdout}\n` };
}

function json(value: unknown) {
  return ok(JSON.stringify(value, null, 2));
}

function parseId<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: string, what: string, hint: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new PluginCliError(`${JSON.stringify(value)} is not a ${what}`, { code: "invalid_value", hint });
  return parsed.data;
}

async function wrap<T>(work: () => Promise<T> | T): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof StoreError) {
      throw new PluginCliError(error.message, {
        code: error.code,
        ...(error.code === "not_found" ? { hint: "List tasks with `bb tasks list`." } : {}),
      });
    }
    throw error;
  }
}

const jsonOption = { type: "boolean", description: "Print JSON instead of text" } as const;
const projectOption = {
  type: "string",
  description: "Project id (proj_…). Defaults to the current thread's project.",
  aliases: ["project-id"],
} as const;

export function registerCli(bb: BbPluginApi, service: TaskService): void {
  async function project(option: string | undefined, ctx: PluginCliContext): Promise<string> {
    const id = option ?? ctx.projectId;
    if (!id) {
      throw new PluginCliError("No project", {
        code: "missing_required",
        hint: "Run from a thread, or pass --project <proj_…> (see `bb project list`).",
      });
    }
    parseId(projectIdSchema, id, "project id", "Project ids look like proj_…");
    return wrap(() => service.requireProject(id));
  }

  function taskId(value: string): string {
    return parseId(taskIdSchema, value, "task id", "Task ids look like tsk_…; find them with `bb tasks list`.");
  }

  function lanesOf(projectId: string) {
    return new Map(service.store.lanes(projectId).map((lane) => [lane.id, lane]));
  }

  function parseLabels(values: string[]): string[] | undefined {
    if (values.length === 0) return undefined;
    const parsed = labelsSchema.safeParse(values);
    if (!parsed.success) {
      throw new PluginCliError(`Labels: at most ${LABELS_MAX}, each 1-${LABEL_MAX} characters`, { code: "invalid_value" });
    }
    return parsed.data;
  }

  bb.cli.register(
    defineCli({
      name: CLI_NAME,
      summary: "Task Board: list, create, move and comment on tasks",
      description:
        "Tasks live on a per-project board with lanes (To do, In progress, Review, Done). Lanes are named by id, name or kind: todo, doing, review, done.",
      commands: {
        list: cliCommand({
          summary: "List open tasks in lane order (paged)",
          options: {
            project: projectOption,
            "all-projects": { type: "boolean", description: "List every project's tasks" },
            lane: { type: "string", description: "Lane id, name or kind (todo, doing, review, done)" },
            query: { type: "string", description: "Text to find in title or description", aliases: ["search", "q"] },
            label: { type: "string", description: "Only tasks with this label" },
            archived: { type: "boolean", description: "List archived tasks instead" },
            limit: { type: "integer", min: 1, max: 100, default: 25, description: "Tasks per page (1-100)" },
            offset: { type: "integer", min: 0, max: 1_000_000, default: 0, description: "Skip this many tasks" },
            json: jsonOption,
          },
          async run({ options }, ctx) {
            const projectId = options["all-projects"] ? null : await project(options.project, ctx);
            const laneId =
              options.lane && projectId ? (await wrap(() => service.resolveLane(projectId, options.lane!))).id : undefined;
            if (options.lane && !projectId) {
              throw new PluginCliError("--lane needs a single project", { code: "invalid_value", hint: "Drop --all-projects or --lane." });
            }
            const result = service.store.list({
              projectId,
              ...(laneId ? { laneId } : {}),
              ...(options.query ? { query: options.query } : {}),
              ...(options.label ? { label: options.label } : {}),
              archived: options.archived,
              limit: options.limit,
              offset: options.offset,
            });
            if (options.json) return json({ ...result, offset: options.offset, limit: options.limit });
            const lanes = new Map(
              [...new Set(result.tasks.map((task) => task.projectId))].flatMap((id) => [...lanesOf(id)]),
            );
            return ok(
              listView(result.tasks, lanes, { offset: options.offset, total: result.total }, (next) => `bb tasks list --offset ${next}`),
            );
          },
        }),
        show: cliCommand({
          summary: "Show a task with its description, threads and activity",
          positionals: [{ name: "task", description: "Task id (tsk_…)", required: true }],
          options: {
            full: { type: "boolean", description: "Print the whole description (otherwise cut at 4000 characters)" },
            json: jsonOption,
          },
          async run({ positionals, options }) {
            const id = taskId(positionals.task);
            const task = service.task(id, 50);
            if (!task) throw new PluginCliError(`No task ${id}`, { code: "not_found", hint: "List tasks with `bb tasks list`." });
            const statuses = await service.threadStatuses(task.threads.map((link) => link.threadId));
            if (options.json) {
              return json({ task: { ...task, body: options.full ? task.body : task.body.slice(0, 4_000) }, threads: statuses });
            }
            return ok(detailView(task, statuses, { full: options.full }));
          },
        }),
        create: cliCommand({
          summary: "Create a task",
          positionals: [{ name: "title", description: `Title (up to ${TITLE_MAX} characters)`, required: true }],
          options: {
            project: projectOption,
            body: { type: "string", description: `Markdown description (up to ${BODY_MAX} characters)`, aliases: ["description"] },
            lane: { type: "string", description: "Lane id, name or kind; defaults to the first lane" },
            priority: { type: "enum", values: PRIORITIES, description: "Priority" },
            label: { type: "string", repeatable: true, split: ",", description: `Label; repeat or comma-separate (at most ${LABELS_MAX})`, aliases: ["labels"] },
            "jira-key": { type: "string", description: "Jira issue key, e.g. ENG-42 (needs --jira-url)" },
            "jira-url": { type: "string", description: "https URL of the Jira issue" },
            link: { type: "boolean", description: "Link the new task to the current thread" },
            top: { type: "boolean", description: "Put it at the top of the lane instead of the bottom" },
            json: jsonOption,
          },
          constraints: [
            { kind: "requires", option: "jira-key", needs: ["jira-url"] },
            { kind: "requires", option: "jira-url", needs: ["jira-key"] },
          ],
          async run({ positionals, options }, ctx) {
            const projectId = await project(options.project, ctx);
            const title = titleSchema.safeParse(positionals.title);
            if (!title.success) throw new PluginCliError(`Title must be 1-${TITLE_MAX} characters`, { code: "invalid_value" });
            if (options.body && options.body.length > BODY_MAX) {
              throw new PluginCliError(`Description is over ${BODY_MAX} characters`, { code: "invalid_value" });
            }
            let externalRef: ExternalRef | undefined;
            if (options["jira-key"]) {
              const parsed = externalRefSchema.safeParse({ kind: "jira", key: options["jira-key"], url: options["jira-url"] });
              if (!parsed.success) throw new PluginCliError(parsed.error.issues[0]?.message ?? "Invalid Jira reference", { code: "invalid_value" });
              externalRef = parsed.data;
            }
            if (options.link && !ctx.threadId) {
              throw new PluginCliError("--link needs a thread", { code: "invalid_value", hint: "Run it from a thread's shell." });
            }
            const laneId = options.lane ? (await wrap(() => service.resolveLane(projectId, options.lane!))).id : undefined;
            const labels = parseLabels(options.label);
            const card = await wrap(() =>
              service.createTask(
                {
                  projectId,
                  title: title.data,
                  ...(options.body ? { body: options.body } : {}),
                  ...(laneId ? { laneId } : {}),
                  ...(options.priority ? { priority: options.priority as Priority } : {}),
                  ...(labels ? { labels } : {}),
                  ...(externalRef ? { externalRef } : {}),
                  ...(options.top ? { placement: "top" as const } : {}),
                },
                actorFor(ctx),
              ),
            );
            if (options.link && ctx.threadId) await wrap(() => service.linkThread(card.id, ctx.threadId!, actorFor(ctx)));
            const fresh = service.store.card(card.id)!;
            if (options.json) return json(fresh);
            return ok(`Created ${cardLine(fresh, lanesOf(projectId))}${options.link ? "\nLinked to this thread." : ""}`);
          },
        }),
        update: cliCommand({
          summary: "Change a task's title, description, priority or labels",
          positionals: [{ name: "task", description: "Task id (tsk_…)", required: true }],
          options: {
            title: { type: "string", description: `New title (up to ${TITLE_MAX} characters)` },
            body: { type: "string", description: "New description; replaces the old one", aliases: ["description"] },
            priority: { type: "enum", values: PRIORITIES, description: "Priority" },
            label: { type: "string", repeatable: true, split: ",", description: "Replace labels; repeat or comma-separate", aliases: ["labels"] },
            "clear-labels": { type: "boolean", description: "Remove every label" },
            json: jsonOption,
          },
          constraints: [
            { kind: "at-least-one", options: ["title", "body", "priority", "label", "clear-labels"] },
            { kind: "at-most-one", options: ["label", "clear-labels"] },
          ],
          async run({ positionals, options }, ctx) {
            const id = taskId(positionals.task);
            if (options.title !== undefined && !titleSchema.safeParse(options.title).success) {
              throw new PluginCliError(`Title must be 1-${TITLE_MAX} characters`, { code: "invalid_value" });
            }
            if (options.body !== undefined && options.body.length > BODY_MAX) {
              throw new PluginCliError(`Description is over ${BODY_MAX} characters`, { code: "invalid_value" });
            }
            const labels = options["clear-labels"] ? [] : parseLabels(options.label);
            const card = await wrap(() =>
              service.updateTask(
                id,
                {
                  ...(options.title !== undefined ? { title: options.title.trim() } : {}),
                  ...(options.body !== undefined ? { body: options.body } : {}),
                  ...(options.priority ? { priority: options.priority as Priority } : {}),
                  ...(labels ? { labels } : {}),
                },
                actorFor(ctx),
              ),
            );
            if (options.json) return json(card);
            return ok(`Updated ${cardLine(card, lanesOf(card.projectId))}`);
          },
        }),
        move: cliCommand({
          summary: "Move a task to a lane (by id, name or kind) or next to another task",
          positionals: [
            { name: "task", description: "Task id (tsk_…)", required: true },
            { name: "lane", description: "Lane id, name or kind: todo, doing, review, done", required: true },
          ],
          options: {
            after: { type: "string", description: "Place directly after this task (tsk_…) in the lane" },
            before: { type: "string", description: "Place directly before this task (tsk_…) in the lane" },
            top: { type: "boolean", description: "Top of the lane" },
            comment: { type: "string", description: `Also leave this comment (up to ${COMMENT_MAX} characters)`, aliases: ["note", "message"] },
            json: jsonOption,
          },
          constraints: [{ kind: "at-most-one", options: ["after", "before", "top"] }],
          async run({ positionals, options }, ctx) {
            const id = taskId(positionals.task);
            const projectId = service.store.projectOf(id);
            if (!projectId) throw new PluginCliError(`No task ${id}`, { code: "not_found", hint: "List tasks with `bb tasks list`." });
            if (options.comment !== undefined && (options.comment.trim().length === 0 || options.comment.length > COMMENT_MAX)) {
              throw new PluginCliError(`Comment must be 1-${COMMENT_MAX} characters`, { code: "invalid_value" });
            }
            const lane = await wrap(() => service.resolveLane(projectId, positionals.lane));
            const card = await wrap(() =>
              service.moveTask(
                id,
                {
                  laneId: lane.id,
                  ...(options.after ? { afterTaskId: taskId(options.after) } : {}),
                  ...(options.before ? { beforeTaskId: taskId(options.before) } : {}),
                  placement: options.top ? "top" : "bottom",
                },
                actorFor(ctx),
              ),
            );
            if (options.comment) await wrap(() => service.addComment(id, options.comment!.trim(), actorFor(ctx)));
            const fresh = options.comment ? service.store.card(id)! : card;
            if (options.json) return json(fresh);
            return ok(`Moved ${cardLine(fresh, lanesOf(projectId))}`);
          },
        }),
        comment: cliCommand({
          summary: "Leave a comment on a task",
          positionals: [
            { name: "task", description: "Task id (tsk_…)", required: true },
            { name: "body", description: `Comment text (up to ${COMMENT_MAX} characters); quote it`, required: true, variadic: true },
          ],
          options: { json: jsonOption },
          async run({ positionals, options }, ctx) {
            const id = taskId(positionals.task);
            const body = positionals.body.join(" ").trim();
            if (body.length === 0 || body.length > COMMENT_MAX) {
              throw new PluginCliError(`Comment must be 1-${COMMENT_MAX} characters`, { code: "invalid_value" });
            }
            const event = await wrap(() => service.addComment(id, body, actorFor(ctx)));
            if (options.json) return json(event);
            return ok(`Commented on ${id}.`);
          },
        }),
        link: cliCommand({
          summary: "Link a thread to a task (a thread works on one task at a time)",
          positionals: [{ name: "task", description: "Task id (tsk_…)", required: true }],
          options: {
            thread: { type: "string", description: "Thread id (thr_…); defaults to the current thread" },
          },
          async run({ positionals, options }, ctx) {
            const id = taskId(positionals.task);
            const threadId = options.thread ?? ctx.threadId;
            if (!threadId) {
              throw new PluginCliError("No thread", { code: "missing_required", hint: "Pass --thread <thr_…> or run it from a thread." });
            }
            parseId(threadIdSchema, threadId, "thread id", "Thread ids look like thr_…");
            const result = await wrap(() => service.linkThread(id, threadId, actorFor(ctx)));
            return ok(
              `Linked ${threadId} to ${id}.${result.previousTaskId ? ` It was on ${result.previousTaskId}.` : ""}\n` +
                "The thread gets the tasks_ tools and its task from its next session start.",
            );
          },
        }),
        unlink: cliCommand({
          summary: "Remove a thread's link to its task",
          options: {
            thread: { type: "string", description: "Thread id (thr_…); defaults to the current thread" },
          },
          async run({ options }, ctx) {
            const threadId = options.thread ?? ctx.threadId;
            if (!threadId) {
              throw new PluginCliError("No thread", { code: "missing_required", hint: "Pass --thread <thr_…> or run it from a thread." });
            }
            parseId(threadIdSchema, threadId, "thread id", "Thread ids look like thr_…");
            const taskIdWas = await wrap(() => service.unlinkThread(threadId, actorFor(ctx)));
            return ok(taskIdWas ? `Unlinked ${threadId} from ${taskIdWas}.` : `${threadId} was not linked to a task.`);
          },
        }),
        archive: cliCommand({
          summary: "Archive a task (hide it from the board)",
          positionals: [{ name: "task", description: "Task id (tsk_…)", required: true }],
          async run({ positionals }, ctx) {
            const card = await wrap(() => service.setArchived(taskId(positionals.task), true, actorFor(ctx)));
            return ok(`Archived ${card.id}.`);
          },
        }),
        unarchive: cliCommand({
          summary: "Bring an archived task back to the bottom of its lane",
          positionals: [{ name: "task", description: "Task id (tsk_…)", required: true }],
          async run({ positionals }, ctx) {
            const card = await wrap(() => service.setArchived(taskId(positionals.task), false, actorFor(ctx)));
            return ok(`Restored ${cardLine(card, lanesOf(card.projectId))}`);
          },
        }),
        lanes: cliCommand({
          summary: "List the board's lanes",
          options: { project: projectOption, json: jsonOption },
          async run({ options }, ctx) {
            const projectId = await project(options.project, ctx);
            const lanes = service.store.lanes(projectId);
            if (options.json) return json(lanes);
            return ok(
              lanes.length > 0
                ? lanesView(lanes)
                : "This project has no board yet. It gets To do, In progress, Review and Done when you open the board or create a task.",
            );
          },
        }),
        current: cliCommand({
          summary: "Show the task the current thread is linked to",
          options: {
            thread: { type: "string", description: "Thread id (thr_…); defaults to the current thread" },
            json: jsonOption,
          },
          async run({ options }, ctx) {
            const threadId = options.thread ?? ctx.threadId;
            if (!threadId) throw new PluginCliError("No thread", { code: "missing_required", hint: "Pass --thread <thr_…>." });
            const id = service.store.taskIdForThread(threadId);
            if (!id) return options.json ? json({ task: null }) : ok(`${threadId} is not linked to a task.`);
            const task = service.task(id, 15)!;
            const statuses = await service.threadStatuses(task.threads.map((link) => link.threadId));
            return options.json ? json({ task, threads: statuses }) : ok(detailView(task, statuses, { full: false }));
          },
        }),
      },
    }),
  );
}
