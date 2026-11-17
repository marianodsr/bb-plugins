// Live RPC reads (refreshed by the server's tag invalidations) and writes
// with optimistic predictions, shared by the editor and the Review tab.
import { experimental_useRpcMutation, experimental_useRpcQuery } from "@get-bb/plugin-sdk/app";
import type { Comment, FileRef } from "../server/contract";
import { clientContract } from "./contract";

const contract = clientContract;

export function useFileRead(file: FileRef | null) {
  return experimental_useRpcQuery({
    contract,
    method: "readFile",
    input: file ?? { environmentId: "none", path: "none" },
    enabled: file !== null,
  });
}

/**
 * Dev seam for live checks: `localStorage["review-editor.devBaseRef"]` makes
 * the editor compare against another ref (e.g. HEAD~1) in a private browser
 * profile. Unset in normal use; the base is always HEAD.
 */
function devBaseRef(): string | undefined {
  try {
    const ref = globalThis.localStorage?.getItem("review-editor.devBaseRef");
    return ref === null || ref === undefined || ref === "" ? undefined : ref;
  } catch {
    return undefined;
  }
}

export function useBaseRead(file: FileRef | null, enabled: boolean) {
  const ref = devBaseRef();
  return experimental_useRpcQuery({
    contract,
    method: "readBase",
    input: file === null ? { environmentId: "none", path: "none" } : { ...file, ...(ref === undefined ? {} : { ref }) },
    enabled: enabled && file !== null,
  });
}

export function useFileComments(file: FileRef | null) {
  return experimental_useRpcQuery({
    contract,
    method: "listComments",
    input: file ?? { environmentId: "none" },
    enabled: file !== null,
  });
}

export function useEnvironmentComments(environmentId: string | null) {
  return experimental_useRpcQuery({
    contract,
    method: "listComments",
    input: { environmentId: environmentId ?? "none" },
    enabled: environmentId !== null,
  });
}

export function useChangedFiles(environmentId: string | null) {
  return experimental_useRpcQuery({
    contract,
    method: "changedFiles",
    input: { environmentId: environmentId ?? "none" },
    enabled: environmentId !== null,
  });
}

type CommentList = { comments: Comment[] };

/** Rewrite one comment in both list reads that may hold it. */
function patchLists(
  cache: { update: (method: "listComments", input: never, fn: (current: CommentList) => CommentList) => void },
  file: FileRef,
  fn: (comments: Comment[]) => Comment[],
) {
  const update = (current: CommentList): CommentList => ({ comments: fn(current.comments) });
  cache.update("listComments", { environmentId: file.environmentId, path: file.path } as never, update);
  cache.update("listComments", { environmentId: file.environmentId } as never, update);
}

function alreadyReplied(comment: Comment, body: string): boolean {
  const last = comment.replies[comment.replies.length - 1];
  return last !== undefined && last.author === "user" && last.body === body.trim();
}

/** Marks a reply or comment that exists only as a prediction. */
export const PENDING_AT = 0;

export function useCommentWrites(file: FileRef | null) {
  const target = file ?? { environmentId: "none", path: "none" };

  const create = experimental_useRpcMutation({
    contract,
    method: "createComment",
    optimistic(input, cache) {
      if (input.id === undefined) return;
      const predicted: Comment = {
        id: input.id,
        environmentId: input.environmentId,
        threadId: input.threadId ?? null,
        path: input.path,
        startLine: input.startLine,
        endLine: input.endLine,
        snippet: "",
        fileSha256: input.fileSha256 ?? "",
        body: input.body,
        severity: input.severity ?? "note",
        state: "open",
        sentThreadId: null,
        sentAt: null,
        resolvedAt: null,
        resolvedBy: null,
        acknowledgedAt: null,
        createdAt: PENDING_AT,
        updatedAt: PENDING_AT,
        replies: [],
      };
      patchLists(cache as never, input, (comments) => [...comments.filter((comment) => comment.id !== input.id), predicted]);
    },
  });

  const update = experimental_useRpcMutation({
    contract,
    method: "updateComment",
    optimistic(input, cache) {
      patchLists(cache as never, target, (comments) =>
        comments.map((comment) =>
          comment.id === input.id
            ? { ...comment, ...(input.body === undefined ? {} : { body: input.body }), ...(input.severity === undefined ? {} : { severity: input.severity }) }
            : comment,
        ),
      );
    },
  });

  const remove = experimental_useRpcMutation({
    contract,
    method: "deleteComment",
    optimistic(input, cache) {
      patchLists(cache as never, target, (comments) => comments.filter((comment) => comment.id !== input.id));
    },
  });

  const setState = experimental_useRpcMutation({
    contract,
    method: "setCommentState",
    optimistic(input, cache) {
      patchLists(cache as never, target, (comments) =>
        comments.map((comment) => {
          if (comment.id !== input.id) return comment;
          if (input.state === "resolved") {
            return { ...comment, state: "resolved", resolvedBy: "user", resolvedAt: PENDING_AT, acknowledgedAt: PENDING_AT };
          }
          if (comment.state !== "resolved") return comment;
          return { ...comment, state: comment.sentThreadId === null ? "open" : "sent", resolvedBy: null, resolvedAt: null, acknowledgedAt: null };
        }),
      );
    },
  });

  const reply = experimental_useRpcMutation({
    contract,
    method: "replyToComment",
    optimistic(input, cache) {
      patchLists(cache as never, target, (comments) =>
        comments.map((comment) =>
          // Predictions replay over confirmed reads: skip once the server has it.
          comment.id === input.commentId && !alreadyReplied(comment, input.body)
            ? {
                ...comment,
                replies: [...comment.replies, { id: -1 - comment.replies.length, author: "user", threadId: null, body: input.body, createdAt: PENDING_AT }],
              }
            : comment,
        ),
      );
    },
  });

  const markSent = experimental_useRpcMutation({
    contract,
    method: "markSent",
    optimistic(input, cache) {
      const ids = new Set(input.commentIds);
      patchLists(cache as never, target, (comments) =>
        comments.map((comment) =>
          ids.has(comment.id)
            ? { ...comment, sentThreadId: input.threadId, sentAt: PENDING_AT, state: comment.state === "open" ? "sent" : comment.state }
            : comment,
        ),
      );
    },
  });

  const acknowledge = experimental_useRpcMutation({
    contract,
    method: "acknowledgeComments",
    optimistic(input, cache) {
      const ids = new Set(input.ids);
      patchLists(cache as never, target, (comments) =>
        comments.map((comment) =>
          ids.has(comment.id) && comment.state === "resolved" && comment.acknowledgedAt === null
            ? { ...comment, acknowledgedAt: PENDING_AT }
            : comment,
        ),
      );
    },
  });

  const save = experimental_useRpcMutation({ contract, method: "saveFile" });

  return { create, update, remove, setState, reply, markSent, acknowledge, save };
}

/** Whether a Helix is open for this workspace (Helix Bridge's Open in Helix). */
export function useHelixStatus(environmentId: string | null, threadId: string | null) {
  return experimental_useRpcQuery({ contract, method: "helixStatus", input: { environmentId: environmentId ?? "none", ...(threadId ? { threadId } : {}) }, enabled: environmentId !== null });
}

export function useOpenInHelix() {
  return experimental_useRpcMutation({ contract, method: "openInHelix" });
}
