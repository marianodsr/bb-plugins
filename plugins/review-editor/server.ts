// Review Editor backend: open a workspace file, edit it with a CAS-guarded
// save, see its git changes, comment on line ranges, and hand the comments to
// a thread whose agent replies to and resolves each one.
//
// server/contract.ts is the RPC contract (app.tsx imports only its type);
// server/service.ts holds every operation the RPC, `bb review` and the agent
// tools share.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { registerCli } from "./server/cli";
import { rpcContract, tags } from "./server/contract";
import { ReviewService } from "./server/service";
import { MIGRATIONS, Store } from "./server/store";
import { TOOL_NAMES, registerTools } from "./server/tools";

export { rpcContract } from "./server/contract";
export type * from "./server/contract";

export const SKILL_NAME = "review-editor";

// Helix Bridge shows comments in the editor; tell it which files changed so
// it need not poll. Fire and forget: a comment write never waits for or fails
// on it. Whether it is installed is re-checked at most every 30 s.
const HELIX_BRIDGE = "helix-bridge";

function helixBridgeNotifier(bb: BbPluginApi) {
  let known: { at: number; present: boolean } | null = null;
  const present = async () => {
    if (known && Date.now() - known.at < 30_000) return known.present;
    const listed = (await bb.sdk.plugins.list()) as unknown as { id: string; status?: string }[] | { plugins: { id: string; status?: string }[] };
    const plugins = Array.isArray(listed) ? listed : listed.plugins;
    known = { at: Date.now(), present: plugins.some((p) => p.id === HELIX_BRIDGE && (p.status === undefined || p.status === "running")) };
    return known.present;
  };
  return (files: readonly { environmentId: string; path: string }[]): void => {
    void (async () => {
      if (!(await present())) return;
      for (const { environmentId, path } of files) {
        await bb.sdk.plugins.callRpc({ pluginId: HELIX_BRIDGE, method: "commentsChanged", input: { environmentId, path }, outputSchema: z.unknown() }).catch(() => {});
      }
    })().catch(() => {});
  };
}

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const store = new Store(db);
  const service = new ReviewService({
    sdk: () => bb.sdk,
    store,
    invalidate: (list) => bb.rpc.experimental_invalidate(list),
    commentsChanged: helixBridgeNotifier(bb),
    log: (message) => bb.log.warn(message),
  });

  bb.rpc.register(rpcContract, {
    resolveHostFile: ({ hostId, path }) => service.resolveHostFile(hostId, path),
    readFile: (file) => service.readFile(file),
    readBase: (input) => service.readBase(input),
    saveFile: (input) => service.saveFile(input),
    changedFiles: ({ environmentId, target }) => service.changedFiles(environmentId, target),
    listComments: (filter) => ({ comments: service.listComments(filter) }),
    getComment: ({ id }) => service.getComment(id),
    createComment: (input) => service.createComment(input),
    updateComment: ({ id, ...patch }) => service.updateComment(id, patch),
    deleteComment: ({ id }) => ({ deleted: service.deleteComment(id) }),
    setCommentState: ({ id, state }) => service.setState(id, state, "user"),
    acknowledgeComments: ({ ids }) => ({ acknowledged: service.acknowledge(ids) }),
    replyToComment: ({ commentId, body }) => service.reply(commentId, body, "user", null),
    syncAnchors: (file) => service.syncFile(file),
    compilePrompt: ({ commentIds }) => service.compile(commentIds),
    markSent: async ({ commentIds, threadId }) => ({ comments: await service.markSent(commentIds, threadId) }),
    sendToThread: ({ commentIds, threadId }) => service.sendToThread(commentIds, threadId),
  }, {
    experimental_discoverable: true,
    experimental_description: "Workspace files with CAS saves, git changes, and line comments handed to threads.",
  });

  registerCli(bb, service);
  registerTools(bb, service);

  // The tools are always offered: a session built before comments arrive
  // keeps its tool list, so gating them on sent comments would hide them
  // from exactly the thread that needs them. The instruction is only a nudge.
  bb.agents.configure((context) => {
    const unresolved = service.unresolvedForThread(context.thread.id, context.pluginMetadata);
    return {
      tools: [...TOOL_NAMES],
      skills: [SKILL_NAME],
      ...(unresolved > 0
        ? {
            instructions:
              `Review Editor: this thread has ${unresolved} unresolved review ${unresolved === 1 ? "comment" : "comments"} on code. ` +
              "Call review_list_comments to read them with their current code. For each one, make the change or explain why not, " +
              "reply with review_reply, and call review_resolve once it is handled.",
          }
        : {}),
    };
  });

  // Files and refs change outside the plugin (agents, terminals, git). Mark
  // the matching reads stale so open editors reload and re-anchor.
  bb.background.service("environment-changes", {
    async start(signal) {
      const unsubscribe = bb.sdk.subscribe({
        event: "environment:changed",
        callback: (event) => {
          const environmentId = event.id;
          if (environmentId === undefined) return;
          const changes = new Set(event.changes);
          const stale: string[] = [];
          if (changes.has("work-status-changed")) stale.push(tags.envFiles(environmentId), tags.git(environmentId));
          if (changes.has("git-refs-changed") || changes.has("git-branches-changed")) stale.push(tags.git(environmentId));
          if (changes.has("metadata-changed") || changes.has("environment-deleted") || changes.has("status-changed")) {
            service.forgetEnvironment(environmentId);
          }
          if (stale.length > 0) bb.rpc.experimental_invalidate([...new Set(stale)]);
        },
      });
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      unsubscribe();
    },
  });
}
