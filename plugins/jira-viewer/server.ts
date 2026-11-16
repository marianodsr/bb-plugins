// Jira Viewer: read Jira Cloud issues beside the chat. Read-only.
//
// This file only wires registrations. The logic lives in src/: the REST
// client (src/jira), ADF conversion (src/adf.ts), the SQLite cache
// (src/store.ts) and the service every surface shares (src/service.ts).
import { experimental_PluginRpcRefusal, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { registerCli } from "./src/cli.js";
import { isReady, resolveConfig, settingDescriptors, type ResolvedConfig } from "./src/config.js";
import { listInputSchema, rpcContract } from "./src/contract.js";
import { TASK_BODY_LIMITS, formatDocument } from "./src/format.js";
import { JiraError, abortableSleep, isAbortError } from "./src/jira/client.js";
import { buildMentionProvider } from "./src/mentions.js";
import type { Failure } from "./src/schemas.js";
import { DEFAULT_TIMING, JiraViewerService, errorText, type TaskBoardAdapter } from "./src/service.js";
import { MIGRATIONS, Store } from "./src/store.js";
import { buildTools } from "./src/tools.js";

export { rpcContract };
export type { RpcContract } from "./src/contract.js";

export const TASK_BOARD_PLUGIN_ID = "task-board";

/** Expected failures become RPC refusals with a stable code and a readable message. */
function refuse(failure: Failure): never {
  const code =
    failure.kind === "not_found"
      ? "not_found"
      : failure.kind === "unauthorized" || failure.kind === "forbidden"
        ? "forbidden"
        : failure.kind === "not_configured" || failure.kind === "bad_request"
          ? "invalid"
          : "conflict";
  throw new experimental_PluginRpcRefusal({ code, message: failure.message });
}

function rethrowAsRefusal(error: unknown): never {
  if (error instanceof JiraError) refuse(error.failure);
  throw error;
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define(settingDescriptors);
  const readConfig = async (): Promise<ResolvedConfig> => resolveConfig(await settings.get());

  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const store = new Store(db);
  store.seedViews(Date.now());

  const lifetime = new AbortController();
  bb.onDispose(() => lifetime.abort());

  const taskBoard: TaskBoardAdapter = {
    async available() {
      const { plugins } = await bb.sdk.plugins.list();
      return plugins.some(
        (candidate) => candidate.id === TASK_BOARD_PLUGIN_ID && candidate.status === "running",
      );
    },
    async createTask(input) {
      return bb.sdk.plugins.callRpc({
        pluginId: TASK_BOARD_PLUGIN_ID,
        method: "createTask",
        input,
        outputSchema: z.object({ id: z.string() }),
      });
    },
  };

  const service = new JiraViewerService({
    store,
    readConfig,
    invalidate: (tags) => {
      if (tags.length > 0) bb.rpc.experimental_invalidate([...new Set(tags)]);
    },
    invalidateAll: () => bb.rpc.experimental_invalidateAll(),
    log: bb.log,
    lifetime: lifetime.signal,
    taskBoard,
  });

  let current = await readConfig();
  if (!isReady(current)) {
    bb.status.needsConfiguration(
      `Set the Jira site, account email and API token in Settings → Installed plugins → Jira Viewer (missing: ${current.missing.join(", ")}).`,
    );
  }
  settings.onChange((next) => {
    const previous = current;
    current = resolveConfig(next);
    service.onConfigChanged(previous, current);
    if (isReady(current)) {
      void service.checkConnection(lifetime.signal).catch((error: unknown) => {
        if (!isAbortError(error)) bb.log.warn(`Connection check failed: ${errorText(error)}`);
      });
    }
  });

  bb.rpc.register(rpcContract, {
    status: () => service.status(),
    checkConnection: (_input, ctx) => service.checkConnection(ctx.experimental_signal),

    "views.list": () => ({ views: service.listViews() }),
    "views.create": ({ name, jql }) => service.createView(name, jql),
    "views.update": ({ id, name, jql }) => {
      const view = service.updateView(id, {
        ...(name !== undefined ? { name } : {}),
        ...(jql !== undefined ? { jql } : {}),
      });
      if (!view) throw new experimental_PluginRpcRefusal({ code: "not_found", message: "That view no longer exists." });
      return view;
    },
    "views.delete": ({ id }) => ({ removed: service.deleteView(id) }),
    "views.reorder": ({ ids }) => ({ views: service.reorderViews(ids) }),

    "issues.list": (input, ctx) => {
      const source = service.resolveSource(input);
      if (!source) {
        throw new experimental_PluginRpcRefusal({ code: "not_found", message: "That view no longer exists." });
      }
      return service.list(source, { limit: input.limit, signal: ctx.experimental_signal });
    },
    "issue.get": ({ key }, ctx) => service.issue(key, { signal: ctx.experimental_signal }),
    "issue.context": async ({ key }, ctx) => {
      try {
        const { doc, fromCache, fetchedAt } = await service.issueForReading(key, ctx.experimental_signal);
        return {
          key: doc.key,
          markdown: formatDocument(doc, {
            maxDescriptionChars: 8_000,
            maxComments: 5,
            maxCommentChars: 1_500,
            includeComments: true,
          }),
          fetchedAt,
          fromCache,
        };
      } catch (error) {
        rethrowAsRefusal(error);
      }
    },
    refresh: async (input, ctx) => {
      if (input.key !== undefined) {
        const result = await service.issue(input.key, { force: true, signal: ctx.experimental_signal });
        return { error: result.error };
      }
      const source = service.resolveSource(input);
      if (!source) {
        throw new experimental_PluginRpcRefusal({ code: "not_found", message: "That view no longer exists." });
      }
      const result = await service.list(source, {
        limit: input.limit,
        force: true,
        signal: ctx.experimental_signal,
      });
      return { error: result.error };
    },

    issueSummary: ({ key }, ctx) => service.issueSummary(key, ctx.experimental_signal),

    "thread.issues": async ({ threadId }) => {
      const keys = service.threadIssueKeys(threadId);
      return { keys, issues: await service.rowsFor(keys) };
    },
    "thread.link": ({ threadId, key }) => ({ linked: service.linkThread(threadId, key) }),
    "thread.unlink": ({ threadId, key }) => ({ removed: service.unlinkThread(threadId, key) }),

    addToTaskBoard: async ({ key, projectId }, ctx) => {
      let doc;
      try {
        ({ doc } = await service.issueForReading(key, ctx.experimental_signal));
      } catch (error) {
        rethrowAsRefusal(error);
      }
      try {
        const { id } = await service.addToTaskBoard({
          key: doc.key,
          title: doc.summary || doc.key,
          body: formatDocument(doc, TASK_BODY_LIMITS),
          url: doc.url,
          ...(projectId ? { projectId } : {}),
        });
        return { id, route: `/plugins/${TASK_BOARD_PLUGIN_ID}/board/task/${encodeURIComponent(id)}` };
      } catch (error) {
        if (isAbortError(error)) throw error;
        throw new experimental_PluginRpcRefusal({
          code: "conflict",
          message: `Could not add ${doc.key} to Task Board: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    },
  });

  // While a client watches a list or an issue, keep it fresh in the background.
  bb.rpc.experimental_whileWatched("issues.list", async (read, signal) => {
    if (!("input" in read)) return;
    const parsed = listInputSchema.safeParse(read.input);
    if (!parsed.success) return;
    while (!signal.aborted) {
      try {
        await abortableSleep(DEFAULT_TIMING.listStaleMs, signal);
      } catch {
        return;
      }
      const source = service.resolveSource(parsed.data);
      if (!source || !isReady(await readConfig())) continue;
      await service.refreshList(source.jql, parsed.data.limit);
    }
  });
  bb.rpc.experimental_whileWatched("issue.get", async (read, signal) => {
    if (!("input" in read)) return;
    const parsed = z.object({ key: z.string() }).safeParse(read.input);
    if (!parsed.success) return;
    const key = parsed.data.key.trim().toUpperCase();
    while (!signal.aborted) {
      try {
        await abortableSleep(DEFAULT_TIMING.docStaleMs, signal);
      } catch {
        return;
      }
      if (!isReady(await readConfig())) continue;
      await service.refreshIssue(key);
    }
  });

  registerCli((registration) => bb.cli.register(registration), service);

  const [searchTool, getIssueTool] = buildTools(service);
  bb.agents.registerTool(searchTool);
  bb.agents.registerTool(getIssueTool);

  bb.ui.registerMentionProvider(buildMentionProvider(service, readConfig));

  bb.events.on("thread.deleted", ({ thread }) => service.forgetThread(thread.id));

  // Verify the saved credentials once per load, after registration completes.
  bb.background.service("connection-check", {
    async start(signal) {
      if (isReady(await readConfig())) {
        await service.checkConnection(signal).catch(() => undefined);
      }
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  });
}
