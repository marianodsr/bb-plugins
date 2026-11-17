// `:bb-send`, `:bb-ask`, `:bb-comment` and `:bb-comments-send` from Helix.
//
// send     -> a draft in the bound thread's composer (the app inserts it when
//             that composer is on screen, or when the thread is next opened);
//             with `sendNow`, sent at once.
// ask      -> sent at once: the question, then the selection.
// comment  -> a Review Editor comment when that plugin runs (one list, one
//             agent loop), else a pending comment kept here.
// flush    -> every pending comment of the thread, through Review Editor's own
//             sendToThread, or compiled here.
import { randomUUID } from "node:crypto";
import { relative } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { SendRecord } from "../shared/host-contract";
import type { SendEvent } from "../shared/protocol";
import { type BoundInstance, within } from "./bridge";
import { capLines, displayPath, fence, lineSpan, rangeLines, rootsOf } from "./format";
import type { HelixService } from "./service";
import type { LocalComment, Store } from "./store";

type Sdk = BbPluginApi["sdk"];

export const REVIEW_EDITOR = "review-editor";
const MAX_SEND_LINES = 300;

const sendEventSchema = z.object({
  kind: z.enum(["send", "ask", "comment", "flush"]),
  note: z.string().max(20_000).catch(""),
  path: z.string().nullable().catch(null),
  docId: z.number().catch(0),
  languageId: z.string().catch("text"),
  version: z.number().catch(0),
  modified: z.boolean().catch(false),
  ranges: z
    .array(z.object({ start: z.object({ line: z.number().int(), col: z.number().int() }), end: z.object({ line: z.number().int(), col: z.number().int() }), text: z.string().catch("") }))
    .catch([]),
  truncated: z.boolean().catch(false),
  sendNow: z.boolean().catch(false),
});

const reviewCommentSchema = z.object({ id: z.string(), threadId: z.string().nullable(), state: z.string(), path: z.string(), startLine: z.number(), endLine: z.number(), body: z.string() }).passthrough();

export interface SendDeps {
  sdk(): Sdk;
  service: HelixService;
  store: Store;
  /** A draft is waiting for this thread's composer. */
  draftReady(threadId: string): void;
  /** A comment was added or sent: refresh the annotations in Helix. */
  commentsChanged(): void;
  /** `:bb-files` in a Helix the editor page shows: open its tree on `path`. */
  filesRequested?(threadId: string, path: string | null): void;
  /** `:bb-review <target>`: start or end a review. Returns the status-line text. */
  reviewRequested?(instance: BoundInstance, target: string): Promise<string>;
  log(message: string): void;
}

/** The compact block a selection becomes: path and lines, fenced code, note. */
export function selectionBlock(event: SendEvent, roots: string[]): string {
  const path = displayPath(event.path, roots);
  const parts: string[] = [];
  let budget = MAX_SEND_LINES;
  const cursorsOnly = event.ranges.every((r) => r.start.line === r.end.line && r.start.col === r.end.col);
  for (const range of event.ranges.slice(0, 20)) {
    const lines = rangeLines(range);
    const where = cursorsOnly ? `\`${path}:${range.start.line}\`` : `\`${path}:${lineSpan(lines.start, lines.end)}\``;
    if (budget <= 0) {
      parts.push(`${where} (not included: over ${MAX_SEND_LINES} lines; read it from the file)`);
      continue;
    }
    const capped = capLines(range.text, budget);
    budget -= capped.text.split("\n").length;
    parts.push(`${where}${event.modified ? " (unsaved changes in the editor; the file on disk differs)" : ""}\n${fence(capped.text, event.languageId)}${capped.dropped ? `\n(${capped.dropped} more lines not included)` : ""}`);
  }
  if (event.ranges.length > 20) parts.push(`(${event.ranges.length - 20} more selections not included)`);
  if (event.truncated) parts.push("(the editor truncated this selection)");
  return parts.join("\n\n");
}

export class SendHandler {
  private reviewEditor: { at: number; running: boolean } | null = null;

  constructor(private readonly deps: SendDeps) {}

  async reviewEditorRunning(): Promise<boolean> {
    if (this.reviewEditor && Date.now() - this.reviewEditor.at < 30_000) return this.reviewEditor.running;
    let running = false;
    try {
      const plugins = (await this.deps.sdk().plugins.list()) as unknown as { id: string; status?: string }[] | { plugins: { id: string; status?: string }[] };
      const list = Array.isArray(plugins) ? plugins : plugins.plugins;
      running = list.some((p) => p.id === REVIEW_EDITOR && (p.status === undefined || p.status === "running"));
    } catch {
      running = false;
    }
    this.reviewEditor = { at: Date.now(), running };
    return running;
  }

  async handle(record: SendRecord, instance: BoundInstance | null): Promise<string> {
    if (!instance) return "dropped: the instance is gone";
    const kind = (record.event as { kind?: unknown }).kind;
    if (kind === "files" || kind === "review") return this.handleRequest(kind, record.event, instance);
    const parsed = sendEventSchema.safeParse(record.event);
    if (!parsed.success) {
      await this.deps.service.status(instance, "bb could not read that send", "error");
      return "dropped: malformed event";
    }
    const event = parsed.data as SendEvent;
    const threadId = instance.threadId;
    if (!threadId) {
      await this.deps.service.status(instance, "This Helix is not bound to a bb thread: run `bb hx bind` or open it from a thread", "error");
      return "dropped: not bound";
    }
    const info = await this.deps.service.threadInfo(threadId);
    const title = info.title ?? threadId;
    const roots = rootsOf(instance);
    try {
      switch (event.kind) {
        case "send": {
          const text = [selectionBlock(event, roots), event.note.trim()].filter(Boolean).join("\n\n");
          if (event.sendNow) {
            await this.sendNow(threadId, text);
            await this.deps.service.status(instance, `Sent to ${title}`);
            return "sent";
          }
          const summary = `${displayPath(event.path, roots)}${event.ranges[0] ? `:${lineSpan(rangeLines(event.ranges[0]).start, rangeLines(event.ranges[event.ranges.length - 1]!).end)}` : ""}`;
          this.deps.store.addDraft({ id: `drf_${randomUUID().slice(0, 12)}`, threadId, text, summary, createdAt: Date.now() });
          this.deps.draftReady(threadId);
          await this.deps.service.status(instance, `Draft in ${title}`);
          return "draft";
        }
        case "ask": {
          const question = event.note.trim() || "What about this code?";
          await this.sendNow(threadId, `${question}\n\n${selectionBlock(event, roots)}`);
          await this.deps.service.status(instance, `Asked ${title}`);
          return "asked";
        }
        case "comment":
          return await this.comment(instance, event, threadId, info.environmentId, info.path);
        case "flush":
          return await this.flush(instance, threadId, title, info.environmentId);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.log(`send ${event.kind} from ${instance.key} failed: ${message}`);
      await this.deps.service.status(instance, `bb: ${message}`, "error");
      return `failed: ${message}`;
    }
  }

  /** `:bb-files` and `:bb-review`: not messages, requests to bb. */
  private async handleRequest(kind: "files" | "review", event: Record<string, unknown>, instance: BoundInstance): Promise<string> {
    const threadId = instance.threadId;
    if (!threadId) {
      await this.deps.service.status(instance, "This Helix is not bound to a bb thread: run `bb hx bind` or open it from a thread", "error");
      return "dropped: not bound";
    }
    if (kind === "files") {
      this.deps.filesRequested?.(threadId, typeof event.path === "string" ? event.path : null);
      return "files";
    }
    const target = typeof event.target === "string" ? event.target.trim() : "";
    if (!this.deps.reviewRequested) {
      await this.deps.service.status(instance, "Reviews need a newer Helix Bridge", "error");
      return "review: unsupported";
    }
    const message = await this.deps.reviewRequested(instance, target).catch((error: unknown) => `bb: ${error instanceof Error ? error.message : String(error)}`);
    await this.deps.service.status(instance, message, message.startsWith("bb: ") ? "error" : "info");
    return `review ${target || "(none)"}`;
  }

  private async sendNow(threadId: string, text: string): Promise<void> {
    await this.deps.sdk().threads.send({ threadId, mode: "queue-if-active", input: [{ type: "text", text, mentions: [] }] });
  }

  private async comment(instance: BoundInstance, event: SendEvent, threadId: string, environmentId: string | null, environmentPath: string | null): Promise<string> {
    const body = event.note.trim();
    if (!body) {
      await this.deps.service.status(instance, "A comment needs text: :bb-comment <text>", "warning");
      return "dropped: empty comment";
    }
    const range = event.ranges[0];
    if (!event.path || !range) {
      await this.deps.service.status(instance, "Select the lines to comment on first", "warning");
      return "dropped: no selection";
    }
    const lines = rangeLines(range);
    let refused: string | null = null;
    if (environmentId && environmentPath && within(environmentPath, event.path) && (await this.reviewEditorRunning())) {
      try {
        await this.deps.sdk().plugins.callRpc({
          pluginId: REVIEW_EDITOR,
          method: "createComment",
          input: { environmentId, path: relative(environmentPath, event.path), startLine: lines.start, endLine: lines.end, body, threadId },
          outputSchema: reviewCommentSchema,
        });
        const pending = await this.reviewPending(environmentId, threadId);
        await this.deps.service.status(instance, `Comment added: ${pending.length} pending for ${await this.titleOf(threadId)} (:bb-comments-send)`);
        this.deps.commentsChanged();
        return "comment (review-editor)";
      } catch (error) {
        // Review Editor quotes the file on disk; lines that exist only in the
        // unsaved buffer are refused. Keep the comment here instead.
        refused = (error instanceof Error ? error.message : String(error)).replace(/^HTTP \d+: /u, "");
      }
    }
    const comment: LocalComment = {
      id: `hxc_${randomUUID().slice(0, 10)}`,
      threadId,
      path: event.path,
      languageId: event.languageId,
      startLine: lines.start,
      endLine: lines.end,
      snippet: range.text,
      body,
      modified: event.modified,
      createdAt: Date.now(),
      sentAt: null,
    };
    this.deps.store.addComment(comment);
    const pending = this.deps.store.pendingComments(threadId);
    await this.deps.service.status(instance, refused ? `Comment kept in Helix Bridge (Review Editor: ${refused}): ${pending.length} pending (:bb-comments-send)` : `Comment added: ${pending.length} pending (:bb-comments-send)`);
    this.deps.commentsChanged();
    return refused ? `comment (local; review-editor refused: ${refused})` : "comment (local)";
  }

  private async reviewPending(environmentId: string, threadId: string): Promise<z.infer<typeof reviewCommentSchema>[]> {
    const { comments } = await this.deps.sdk().plugins.callRpc({
      pluginId: REVIEW_EDITOR,
      method: "listComments",
      input: { environmentId, states: ["open"] },
      outputSchema: z.object({ comments: z.array(reviewCommentSchema) }),
    });
    return comments.filter((c) => c.threadId === threadId);
  }

  private async flush(instance: BoundInstance, threadId: string, title: string, environmentId: string | null): Promise<string> {
    let sent = 0;
    const parts: string[] = [];
    if (environmentId && (await this.reviewEditorRunning())) {
      const pending = await this.reviewPending(environmentId, threadId);
      if (pending.length > 0) {
        await this.deps.sdk().plugins.callRpc({
          pluginId: REVIEW_EDITOR,
          method: "sendToThread",
          input: { commentIds: pending.slice(0, 100).map((c) => c.id), threadId },
          outputSchema: z.object({ prompt: z.string() }).passthrough(),
        });
        sent += pending.length;
        parts.push(`${pending.length} (review-editor)`);
      }
    }
    const local = this.deps.store.pendingComments(threadId);
    if (local.length > 0) {
      const roots = rootsOf(instance);
      const blocks = local.map((c, i) => `${i + 1}. \`${displayPath(c.path, roots)}:${lineSpan(c.startLine, c.endLine)}\`${c.modified ? " (unsaved changes in the editor)" : ""}\n${fence(capLines(c.snippet, 60).text, c.languageId)}\n${c.body}`);
      const text = `Review comments from Helix (${local.length}). For each one, make the change or explain why not.\n\n${blocks.join("\n\n")}`;
      await this.sendNow(threadId, text);
      this.deps.store.markCommentsSent(local.map((c) => c.id));
      sent += local.length;
      parts.push(`${local.length} (local)`);
    }
    if (sent === 0) {
      await this.deps.service.status(instance, "No pending comments", "warning");
      return "flushed 0";
    }
    await this.deps.service.status(instance, `Sent ${sent} comment${sent === 1 ? "" : "s"} to ${title}`);
    this.deps.commentsChanged();
    return `flushed ${parts.join(" + ")}`;
  }

  private async titleOf(threadId: string): Promise<string> {
    return (await this.deps.service.threadInfo(threadId)).title ?? threadId;
  }
}
