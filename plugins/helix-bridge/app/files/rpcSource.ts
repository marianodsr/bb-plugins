// The tree's FilesSource and the server's half of its ThreadLink, over the
// plugin's RPC (`filesList`, `filesOp`, `filesOpen`, `filesAsk`, `agentFiles`)
// and its realtime events (`files-changed`, `agent-files`).
import { useMemo, useRef, useState } from "react";
import { useRealtime } from "@get-bb/plugin-sdk/app";
import { useHelixRpc } from "../data";
import type { ServerLink } from "./threadLink";
import type { DirListing, FilesSource } from "./types";

/** `filesList` takes this many folders in one call. */
const LIST_BATCH = 64;

/** How long the last listings took, end to end, for the live preview (`~files/<thread>`). */
export const listTimings: { ms: number; dirs: number }[] = [];

/** The workspace's absolute path per thread, once a listing has said it. */
const roots = new Map<string, string>();

export function useRpcFiles(threadId: string): { source: FilesSource; server: ServerLink; root: string | null } {
  const rpc = useHelixRpc();
  const changed = useRef(new Set<(dirs: string[] | null) => void>());
  const agent = useRef(new Set<() => void>());
  const [root, setRoot] = useState<string | null>(() => roots.get(threadId) ?? null);

  useRealtime("files-changed", (payload: unknown) => {
    const message = payload as { threadId?: string; dirs?: string[] | null } | null;
    if (message?.threadId !== threadId) return;
    for (const listener of changed.current) listener(message.dirs ?? null);
  });
  useRealtime("agent-files", (payload: unknown) => {
    if ((payload as { threadId?: string } | null)?.threadId !== threadId) return;
    for (const listener of agent.current) listener();
  });

  return useMemo(() => {
    const source: FilesSource = {
      async list(dirs) {
        const listed: Record<string, DirListing> = {};
        const calls: Promise<void>[] = [];
        const started = performance.now();
        for (let i = 0; i < dirs.length; i += LIST_BATCH) {
          calls.push(
            rpc.call("filesList", { threadId, dirs: dirs.slice(i, i + LIST_BATCH) }).then((answer) => {
              Object.assign(listed, answer.dirs);
              if (answer.root && roots.get(threadId) !== answer.root) {
                roots.set(threadId, answer.root);
                setRoot(answer.root);
              }
            }),
          );
        }
        await Promise.all(calls);
        listTimings.push({ ms: performance.now() - started, dirs: dirs.length });
        if (listTimings.length > 20) listTimings.shift();
        return listed;
      },
      op: (op) => rpc.call("filesOp", { threadId, op }),
      async open(path) {
        const opened = await rpc.call("filesOpen", { threadId, path });
        if (!opened.ok) throw new Error(opened.error ?? "Helix did not open the file");
      },
      onChanged(listener) {
        changed.current.add(listener);
        return () => void changed.current.delete(listener);
      },
    };
    const server: ServerLink = {
      ask: (paths, text) => rpc.call("filesAsk", { threadId, kind: "ask", paths, text }),
      write: (path, description) => rpc.call("filesAsk", { threadId, kind: "write", paths: [path], text: description }),
      agentFiles: () => rpc.call("agentFiles", { threadId }),
      onAgentFiles(listener) {
        agent.current.add(listener);
        return () => void agent.current.delete(listener);
      },
    };
    return { source, server, root };
  }, [rpc, threadId, root]);
}
