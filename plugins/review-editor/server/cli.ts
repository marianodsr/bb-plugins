// `bb review`: the same operations as the editor, for agents and shells.
import { PluginCliError, cliCommand, defineCli, type BbPluginApi } from "@get-bb/plugin-sdk";
import {
  COMMENT_STATES,
  SEVERITIES,
  commentBodySchema,
  commentIdSchema,
  environmentIdSchema,
  isRelativePath,
  threadIdSchema,
  type Comment,
  type CommentState,
} from "./contract";
import type { ReviewService } from "./service";

type Sdk = BbPluginApi["sdk"];
type CliContext = { threadId?: string; cwd?: string };

const MAX_LISTED = 200;
const MAX_SNIPPET_LINES = 30;
const UNRESOLVED: CommentState[] = ["open", "sent", "outdated"];

function fail(message: string, code: string, hint?: string): never {
  throw new PluginCliError(message, { code, ...(hint === undefined ? {} : { hint }) });
}

function parseId(value: string): string {
  const parsed = commentIdSchema.safeParse(value);
  if (!parsed.success) fail(`"${value}" is not a comment id`, "invalid_id", "Comment ids look like rc_0123456789; run `bb review comments`.");
  return parsed.data;
}

function parseBody(value: string): string {
  const parsed = commentBodySchema.safeParse(value);
  if (!parsed.success) fail("--body must be 1 to 20000 characters", "invalid_body");
  return parsed.data;
}

function parseLines(value: string): { startLine: number; endLine: number } {
  const match = /^(\d+)(?:[-:](\d+))?$/u.exec(value.trim());
  if (match === null) fail(`--lines "${value}" is not a line or range`, "invalid_lines", "Use --lines 42 or --lines 42-48.");
  const startLine = Number(match[1]);
  const endLine = match[2] === undefined ? startLine : Number(match[2]);
  if (startLine < 1 || endLine < startLine) fail(`--lines "${value}" is not a valid range`, "invalid_lines");
  return { startLine, endLine };
}

/** Rethrow service refusals as CLI errors with their message. */
async function guard<T>(work: () => Promise<T> | T): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof PluginCliError) throw error;
    const code = (error as { code?: unknown }).code;
    fail(error instanceof Error ? error.message : String(error), typeof code === "string" ? code : "failed");
  }
}

export function lineRange(comment: Pick<Comment, "startLine" | "endLine">): string {
  return comment.startLine === comment.endLine ? `${comment.startLine}` : `${comment.startLine}-${comment.endLine}`;
}

/** Plain-text rendering shared by the CLI and the agent tools. */
export function formatComment(comment: Comment, options: { snippet?: boolean } = {}): string {
  const out: string[] = [];
  const state =
    comment.sentThreadId === null
      ? comment.state
      : comment.state === "sent"
        ? `sent to ${comment.sentThreadId}`
        : `${comment.state} (sent to ${comment.sentThreadId})`;
  out.push(`${comment.id}  ${comment.path}:${lineRange(comment)}  ${state}  ${comment.severity}`);
  if (options.snippet) {
    const lines = comment.snippet.split("\n");
    const shown = lines.slice(0, MAX_SNIPPET_LINES);
    shown.forEach((line, index) => out.push(`    ${String(comment.startLine + index).padStart(5)} | ${line}`));
    if (lines.length > shown.length) out.push(`    ... ${lines.length - shown.length} more lines`);
    if (comment.state === "outdated") out.push("    (outdated: this code no longer appears in the file as quoted)");
  }
  for (const line of comment.body.split("\n")) out.push(`  ${line}`);
  for (const reply of comment.replies) {
    out.push(`  - ${reply.author === "agent" ? "agent" : "reviewer"}: ${reply.body.split("\n").join("\n    ")}`);
  }
  return out.join("\n");
}

function formatList(comments: Comment[], snippet: boolean): string {
  if (comments.length === 0) return "No comments.";
  const shown = comments.slice(0, MAX_LISTED).map((comment) => formatComment(comment, { snippet }));
  if (comments.length > MAX_LISTED) shown.push(`... and ${comments.length - MAX_LISTED} more; narrow with --path or --state.`);
  return shown.join("\n\n");
}

const json = { type: "boolean", description: "Print JSON" } as const;
const env = {
  type: "string",
  aliases: ["environment", "environment-id"],
  placeholder: "env-id",
  description: "Environment id. Defaults to the calling thread's environment.",
} as const;

export function registerCli(bb: BbPluginApi, service: ReviewService): void {
  const sdk = (): Sdk => bb.sdk;

  async function environmentFor(option: string | undefined, ctx: CliContext): Promise<string> {
    if (option !== undefined) {
      const parsed = environmentIdSchema.safeParse(option);
      if (!parsed.success) fail(`"${option}" is not an environment id`, "invalid_environment");
      return parsed.data;
    }
    if (ctx.threadId !== undefined) {
      const thread = await sdk().threads.get({ threadId: ctx.threadId });
      if (thread.environmentId !== null) return thread.environmentId;
    }
    fail("No environment", "environment_required", "Pass --env <environment-id> (see `bb environment list`).");
  }

  function relativePath(path: string): string {
    const clean = path.replace(/^\.\//u, "");
    if (!isRelativePath(clean)) fail(`"${path}" must be a path relative to the workspace root`, "invalid_path");
    return clean;
  }

  function threadOption(value: string): string {
    const parsed = threadIdSchema.safeParse(value);
    if (!parsed.success) fail(`"${value}" is not a thread id`, "invalid_thread");
    return parsed.data;
  }

  function out(asJson: boolean, value: unknown, text: string) {
    return { exitCode: 0, stdout: asJson ? JSON.stringify(value, null, 2) : text };
  }

  /** Who is writing: an agent when the CLI runs inside a thread. */
  function author(ctx: CliContext): { author: "user" | "agent"; threadId: string | null } {
    return ctx.threadId === undefined ? { author: "user", threadId: null } : { author: "agent", threadId: ctx.threadId };
  }

  bb.cli.register(
    defineCli({
      name: "review",
      summary: "Review Editor: line comments on workspace files, sent to threads to reply to and resolve",
      description:
        "Comments are anchored to a line range and the quoted code, and move with the code as the file changes. " +
        "Ids look like rc_0123456789.",
      commands: {
        comments: cliCommand({
          summary: "List comments, re-anchoring them to the current files first",
          options: {
            env,
            path: { type: "string", aliases: ["file"], description: "Only this workspace-relative file" },
            thread: { type: "string", description: "Only comments sent to this thread (instead of an environment)" },
            state: {
              type: "enum",
              values: COMMENT_STATES,
              repeatable: true,
              split: ",",
              description: "Only these states. Default: open, sent and outdated",
            },
            all: { type: "boolean", description: "Include resolved comments" },
            snippet: { type: "boolean", aliases: ["code"], description: "Show the quoted code" },
            json,
          },
          constraints: [{ kind: "at-most-one", options: ["state", "all"] }],
          async run({ options }, ctx) {
            const states = options.all ? undefined : options.state.length > 0 ? options.state : UNRESOLVED;
            const filter =
              options.thread !== undefined
                ? { sentThreadId: threadOption(options.thread) }
                : { environmentId: await environmentFor(options.env, ctx) };
            const path = options.path === undefined ? undefined : relativePath(options.path);
            if (path !== undefined && !("environmentId" in filter)) fail("--path needs an environment, not --thread", "invalid_options");
            const before = service.listComments({ ...filter, ...(path === undefined ? {} : { path }) });
            await service.syncComments(before);
            const comments = service.listComments({ ...filter, ...(path === undefined ? {} : { path }), ...(states === undefined ? {} : { states }) });
            return out(options.json, { comments }, formatList(comments, options.snippet));
          },
        }),
        show: cliCommand({
          summary: "Show one comment with its quoted code and replies",
          positionals: [{ name: "id", description: "Comment id", required: true }],
          options: { json },
          async run({ positionals, options }) {
            const id = parseId(positionals.id);
            const comment = await guard(async () => {
              const found = service.getComment(id);
              await service.syncComments([found]);
              return service.getComment(id);
            });
            return out(options.json, comment, formatComment(comment, { snippet: true }));
          },
        }),
        add: cliCommand({
          summary: "Comment on a line range of a file",
          positionals: [{ name: "path", description: "Workspace-relative file path", required: true }],
          options: {
            lines: { type: "string", required: true, aliases: ["line", "range"], placeholder: "start[-end]", description: "One-based line or inclusive range, e.g. 42 or 42-48" },
            body: { type: "string", required: true, aliases: ["message", "text", "comment"], description: "The comment (up to 20000 characters)" },
            severity: { type: "enum", values: SEVERITIES, default: "note", description: "How much it matters" },
            env,
            json,
          },
          async run({ positionals, options }, ctx) {
            const environmentId = await environmentFor(options.env, ctx);
            const comment = await guard(() =>
              service.createComment({
                environmentId,
                path: relativePath(positionals.path),
                ...parseLines(options.lines),
                body: parseBody(options.body),
                severity: options.severity,
                threadId: ctx.threadId ?? null,
              }),
            );
            return out(options.json, comment, `Added\n${formatComment(comment, { snippet: true })}`);
          },
        }),
        reply: cliCommand({
          summary: "Reply to a comment",
          positionals: [{ name: "id", description: "Comment id", required: true }],
          options: {
            body: { type: "string", required: true, aliases: ["message", "text"], description: "The reply (up to 20000 characters)" },
            json,
          },
          async run({ positionals, options }, ctx) {
            const who = author(ctx);
            const comment = await guard(() => service.reply(parseId(positionals.id), parseBody(options.body), who.author, who.threadId));
            return out(options.json, comment, formatComment(comment));
          },
        }),
        resolve: cliCommand({
          summary: "Mark a comment resolved, optionally replying first",
          positionals: [{ name: "id", description: "Comment id", required: true }],
          options: {
            note: { type: "string", aliases: ["body", "message"], description: "A reply to add before resolving" },
            json,
          },
          async run({ positionals, options }, ctx) {
            const id = parseId(positionals.id);
            const who = author(ctx);
            const comment = await guard(() => {
              if (options.note !== undefined) service.reply(id, parseBody(options.note), who.author, who.threadId);
              return service.setState(id, "resolved", who.author);
            });
            return out(options.json, comment, `Resolved ${comment.id}`);
          },
        }),
        reopen: cliCommand({
          summary: "Reopen a resolved comment",
          positionals: [{ name: "id", description: "Comment id", required: true }],
          options: { json },
          async run({ positionals, options }) {
            const comment = await guard(() => service.setState(parseId(positionals.id), "open"));
            return out(options.json, comment, `${comment.id} is ${comment.state}`);
          },
        }),
        delete: cliCommand({
          summary: "Delete a comment and its replies",
          aliases: ["remove", "rm"],
          positionals: [{ name: "id", description: "Comment id", required: true }],
          options: { json },
          async run({ positionals, options }) {
            const id = parseId(positionals.id);
            const deleted = service.deleteComment(id);
            if (!deleted) fail(`No comment ${id}`, "not_found");
            return out(options.json, { deleted }, `Deleted ${id}`);
          },
        }),
        prompt: cliCommand({
          summary: "Print the prompt that hands comments to an agent",
          positionals: [{ name: "ids", description: "Comment ids. Default: every open comment in the environment", variadic: true }],
          options: { env, path: { type: "string", aliases: ["file"], description: "Default to the open comments on this file" }, json },
          async run({ positionals, options }, ctx) {
            const ids = await pickIds(positionals.ids, options.env, options.path, ctx);
            const compiled = await guard(() => service.compile(ids));
            return out(options.json, compiled, compiled.prompt);
          },
        }),
        send: cliCommand({
          summary: "Send comments to a thread and mark them sent",
          positionals: [{ name: "ids", description: "Comment ids. Default: every open comment in the environment", variadic: true }],
          options: {
            thread: { type: "string", required: true, aliases: ["to"], description: "The thread to send to" },
            env,
            path: { type: "string", aliases: ["file"], description: "Default to the open comments on this file" },
            json,
          },
          async run({ positionals, options }, ctx) {
            const threadId = threadOption(options.thread);
            const ids = await pickIds(positionals.ids, options.env, options.path, ctx);
            const sent = await guard(() => service.sendToThread(ids, threadId));
            return out(options.json, { threadId, comments: sent.comments }, `Sent ${sent.comments.length} comments to ${threadId}`);
          },
        }),
        changed: cliCommand({
          summary: "List changed files (bb--git) with comment counts",
          options: { env, json },
          async run({ options }, ctx) {
            const environmentId = await environmentFor(options.env, ctx);
            const changed = await guard(() => service.changedFiles(environmentId));
            if (changed.outcome !== "available") {
              return out(options.json, changed, changed.message);
            }
            const rows = changed.files.map((file) => {
              const open = file.comments.open + file.comments.sent + file.comments.outdated;
              return `${file.changeKind.padEnd(9)} +${file.additions} -${file.deletions}  ${file.path}${open > 0 ? `  (${open} open comments)` : ""}`;
            });
            for (const file of changed.commentedFiles) {
              const open = file.comments.open + file.comments.sent + file.comments.outdated;
              if (open > 0) rows.push(`unchanged          ${file.path}  (${open} open comments)`);
            }
            return out(options.json, changed, rows.length === 0 ? "No changes." : `${changed.shortstat}\n${rows.join("\n")}`);
          },
        }),
        sync: cliCommand({
          summary: "Re-anchor a file's comments to its current content",
          positionals: [{ name: "path", description: "Workspace-relative file path", required: true }],
          options: { env, json },
          async run({ positionals, options }, ctx) {
            const environmentId = await environmentFor(options.env, ctx);
            const result = await guard(() => service.syncFile({ environmentId, path: relativePath(positionals.path) }));
            return out(
              options.json,
              result,
              `Checked ${result.checked}: ${result.moved} moved, ${result.outdated} outdated, ${result.restored} restored`,
            );
          },
        }),
      },
    }),
  );

  async function pickIds(ids: string[], envOption: string | undefined, pathOption: string | undefined, ctx: CliContext): Promise<string[]> {
    if (ids.length > 0) return ids.map(parseId);
    const environmentId = await environmentFor(envOption, ctx);
    const path = pathOption === undefined ? undefined : relativePath(pathOption);
    const open = service.listComments({ environmentId, ...(path === undefined ? {} : { path }), states: ["open"] });
    if (open.length === 0) fail("No open comments to use", "no_comments", "Pass comment ids, or add comments with `bb review add`.");
    return open.slice(0, 100).map((comment) => comment.id);
  }
}
