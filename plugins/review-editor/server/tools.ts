// Agent tools: an agent replies to and resolves the comments sent to its thread.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { commentIdSchema, relativePathSchema, replyBodySchema, type CommentState } from "./contract";
import { formatComment } from "./cli";
import type { ReviewService } from "./service";

export const TOOL_NAMES = ["review_list_comments", "review_reply", "review_resolve"] as const;
const MAX_LISTED = 50;

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function text(value: string, isError = false): ToolResult {
  return { content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) };
}

async function guarded(work: () => Promise<string> | string): Promise<ToolResult> {
  try {
    return text(await work());
  } catch (error) {
    return text(error instanceof Error ? error.message : String(error), true);
  }
}

export function registerTools(bb: BbPluginApi, service: ReviewService): void {
  bb.agents.registerTool({
    name: "review_list_comments",
    description:
      "List the Review Editor comments sent to this thread: id, file path, line range, state, the quoted code, the comment and replies. " +
      "Lines are re-anchored to the current file first.",
    presentation: { label: { pending: "Reading review comments", completed: "Read review comments" } },
    parameters: z
      .object({
        state: z
          .enum(["unresolved", "resolved", "all"])
          .default("unresolved")
          .describe("unresolved (open, sent, outdated), resolved, or all"),
        path: relativePathSchema.optional().describe("Only comments on this workspace-relative file"),
      })
      .strict(),
    async execute({ state, path }, { threadId }) {
      return guarded(async () => {
        const states: CommentState[] | undefined =
          state === "unresolved" ? ["open", "sent", "outdated"] : state === "resolved" ? ["resolved"] : undefined;
        await service.syncComments(service.listComments({ sentThreadId: threadId }));
        const comments = service
          .listComments({ sentThreadId: threadId, ...(states === undefined ? {} : { states }) })
          .filter((comment) => path === undefined || comment.path === path);
        if (comments.length === 0) {
          return state === "unresolved" ? "No unresolved review comments for this thread." : "No matching review comments.";
        }
        const shown = comments.slice(0, MAX_LISTED).map((comment) => formatComment(comment, { snippet: true }));
        if (comments.length > MAX_LISTED) shown.push(`... and ${comments.length - MAX_LISTED} more; pass path to narrow.`);
        return shown.join("\n\n");
      });
    },
  });

  bb.agents.registerTool({
    name: "review_reply",
    description:
      "Reply to a Review Editor comment sent to this thread: say what you changed, or ask the reviewer a question. The reply shows beside the code.",
    presentation: { label: { pending: "Replying to review comment", completed: "Replied to review comment" } },
    parameters: z.object({ commentId: commentIdSchema, body: replyBodySchema }).strict(),
    async execute({ commentId, body }, { threadId }) {
      return guarded(() => {
        service.agentComment(commentId, threadId);
        service.reply(commentId, body, "agent", threadId);
        return `Replied to ${commentId}.`;
      });
    },
  });

  bb.agents.registerTool({
    name: "review_resolve",
    description:
      "Mark a Review Editor comment sent to this thread resolved once it is handled. Optionally add a closing note as a reply.",
    presentation: { label: { pending: "Resolving review comment", completed: "Resolved review comment" } },
    parameters: z
      .object({ commentId: commentIdSchema, note: replyBodySchema.optional().describe("A short reply saying how it was handled") })
      .strict(),
    async execute({ commentId, note }, { threadId }) {
      return guarded(() => {
        service.agentComment(commentId, threadId);
        if (note !== undefined) service.reply(commentId, note, "agent", threadId);
        service.setState(commentId, "resolved", "agent");
        return `Resolved ${commentId}.`;
      });
    },
  });
}
