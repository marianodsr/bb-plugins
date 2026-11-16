// Task Board backend: a per-project kanban of tasks that live in bb.
//
// Wiring only. Storage and every write are in src/store.ts, the shared entry
// point for all surfaces in src/service.ts, the RPC contract in
// src/contract.ts.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { registerAgent } from "./src/agent.js";
import { registerCli } from "./src/cli.js";
import { registerRpc } from "./src/rpc.js";
import { TaskService } from "./src/service.js";

export { rpcContract, type RpcContract } from "./src/contract.js";
export type * from "./src/schemas.js";

export default async function plugin(bb: BbPluginApi) {
  const service = new TaskService(bb);

  registerRpc(bb, service);
  registerCli(bb, service);
  registerAgent(bb, service);

  // Links and thread lifecycle. Status itself is never copied: cards read it
  // from bb through the threadStatuses keyed read, and the watcher only
  // invalidates thread:<id> when bb reports a change to a linked thread.
  bb.events.on("thread.created", ({ thread }) => service.onThreadCreated(thread));
  bb.events.on("thread.deleted", ({ thread }) => service.onThreadDeleted(thread.id));

  bb.background.service("thread-watch", {
    async start(signal) {
      service.watcher.start();
      // The Jira chip links to Jira Viewer only while it runs.
      const stopPlugins = bb.sdk.subscribe({
        event: "system:changed",
        callback: (message) => {
          if (message.changes.includes("plugins-changed")) bb.rpc.experimental_invalidate(["integrations"]);
        },
      });
      signal.addEventListener("abort", stopPlugins, { once: true });
      try {
        await service.reconcile();
      } catch (error) {
        bb.log.warn(`reconcile failed: ${String(error)}`);
      }
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      service.watcher.stop();
    },
  });

  bb.onDispose(() => service.watcher.stop());
}
