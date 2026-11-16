import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";

export const PROJECT = "proj_alpha";
export const OTHER_PROJECT = "proj_beta";

export interface FakeThread {
  id: string;
  projectId: string;
  title: string | null;
  status: "active" | "error" | "idle" | "pending" | "starting" | "stopping";
  displayStatus: string;
  hasPendingInteraction: boolean;
  archivedAt: number | null;
  deleted: boolean;
  originPluginId: string | null;
  metadata: Record<string, unknown>;
}

type Callback = (message: never) => void;

/** A fake host with just enough of bb's projects and threads for the board. */
export async function setup() {
  const threads = new Map<string, FakeThread>();
  const subscriptions: Array<{ event: string; callback: Callback }> = [];
  const projects = [
    { id: PROJECT, name: "Alpha" },
    { id: OTHER_PROJECT, name: "Beta" },
  ];

  const listed = (thread: FakeThread) => ({
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    titleFallback: null,
    status: thread.status,
    runtime: { displayStatus: thread.displayStatus },
    hasPendingInteraction: thread.hasPendingInteraction,
    archivedAt: thread.archivedAt,
    updatedAt: 1,
    originPluginId: thread.originPluginId,
  });

  const { bb, harness } = createFakePluginHost({
    pluginId: "task-board",
    agentSkillIds: ["task-board"],
    sdk: {
      projects: {
        get: async ({ projectId }: { projectId: string }) => {
          const project = projects.find((row) => row.id === projectId);
          if (!project) throw new Error("404");
          return project;
        },
        list: async () => projects,
      },
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          const thread = threads.get(threadId);
          if (!thread || thread.deleted) throw new Error("404");
          return { ...listed(thread), deletedAt: null };
        },
        list: async (args: {
          threadIds?: string[];
          archived?: boolean;
          originPluginId?: string;
          offset?: number;
          limit?: number;
        }) => {
          let rows = [...threads.values()].filter((thread) => !thread.deleted);
          rows = rows.filter((thread) => (args.archived ? thread.archivedAt !== null : thread.archivedAt === null));
          if (args.threadIds) rows = rows.filter((thread) => args.threadIds!.includes(thread.id));
          if (args.originPluginId) rows = rows.filter((thread) => thread.originPluginId === args.originPluginId);
          const offset = args.offset ?? 0;
          return rows.slice(offset, offset + (args.limit ?? 50)).map(listed);
        },
        getPluginMetadata: async ({ threadId }: { threadId: string }) => {
          const thread = threads.get(threadId);
          if (!thread) throw new Error("404");
          return thread.metadata;
        },
        updatePluginMetadata: async ({ threadId, set, remove }: { threadId: string; set?: Record<string, unknown>; remove?: string[] }) => {
          const thread = threads.get(threadId);
          if (!thread) throw new Error("404");
          thread.metadata = { ...thread.metadata, ...(set ?? {}) };
          for (const key of remove ?? []) delete thread.metadata[key];
          return thread.metadata;
        },
        experimental_listPluginMetadata: async ({ threadIds }: { threadIds: string[] }) => ({
          threads: threadIds
            .map((id) => threads.get(id))
            .filter((thread): thread is FakeThread => thread !== undefined && Object.keys(thread.metadata).length > 0)
            .map((thread) => ({ threadId: thread.id, metadata: thread.metadata })),
        }),
      },
      subscribe: (args: { event: string; callback: Callback }) => {
        subscriptions.push(args);
        return () => {
          const index = subscriptions.indexOf(args);
          if (index >= 0) subscriptions.splice(index, 1);
        };
      },
    } as never,
  });
  await plugin(bb);

  function addThread(partial: Partial<FakeThread> & { id: string }): FakeThread {
    const thread: FakeThread = {
      projectId: PROJECT,
      title: `Thread ${partial.id}`,
      status: "idle",
      displayStatus: "idle",
      hasPendingInteraction: false,
      archivedAt: null,
      deleted: false,
      originPluginId: null,
      metadata: {},
      ...partial,
    };
    threads.set(thread.id, thread);
    return thread;
  }

  function emitThreadChanged(id: string, changes: string[]) {
    for (const sub of subscriptions.filter((row) => row.event === "thread:changed")) {
      sub.callback({ type: "changed", entity: "thread", id, changes } as never);
    }
  }

  function invalidations(): string[][] {
    return harness.inspection.experimental_rpcInvalidations.map((tags) => [...(tags ?? ["*"])]);
  }

  async function rpc<T = any>(method: string, input: unknown): Promise<T> {
    return (await harness.behavior.callRpc(method, input)) as T;
  }

  return { bb, harness, threads, subscriptions, addThread, emitThreadChanged, invalidations, rpc };
}

export async function boardOf(env: Awaited<ReturnType<typeof setup>>, projectId = PROJECT) {
  return env.rpc<{
    lanes: Array<{ id: string; name: string; kind: string; taskCount: number }>;
    tasks: Array<{ id: string; laneId: string; title: string; position: string; threadIds: string[] }>;
  }>("board", { projectId });
}

export function laneTitles(board: Awaited<ReturnType<typeof boardOf>>, laneId: string): string[] {
  return board.tasks.filter((task) => task.laneId === laneId).map((task) => task.title);
}
