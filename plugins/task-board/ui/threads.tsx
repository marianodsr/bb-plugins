// Linked-thread status for cards. bb's own sidebar view is the first source
// (no request, always live); threads it does not carry (hidden, archived,
// other projects) come from the threadStatuses keyed read, which the server
// refreshes per thread.
import { createContext, useContext, useMemo, type ReactNode } from "react";
import {
  experimental_useRpcKeyedQuery,
  experimental_useSidebarThreads,
} from "@get-bb/plugin-sdk/app";
import { threadRunStatus, type RunStatus } from "../kit";
import { rpcContract } from "../src/contract";
import type { ThreadState } from "../src/schemas";

export interface ThreadView {
  id: string;
  title: string;
  /** The kit's four states, or archived/missing for links that no longer run. */
  state: RunStatus | "archived" | "missing";
  /** bb's own label for the state, e.g. "Waiting for approval". */
  label: string | null;
  href: string | null;
}

const Context = createContext<Map<string, ThreadView>>(new Map());

function fromRpc(state: ThreadState): ThreadView["state"] {
  return state;
}

/** Resolve every id once for the subtree; cards read with useThreadView. */
export function ThreadStatusProvider({ threadIds, children }: { threadIds: string[]; children: ReactNode }) {
  const { threads } = experimental_useSidebarThreads();
  const live = useMemo(() => new Map(threads.map((thread) => [thread.id, thread])), [threads]);
  const unique = useMemo(() => [...new Set(threadIds)].sort(), [threadIds]);
  const missing = useMemo(() => unique.filter((id) => !live.has(id)), [unique, live]);
  const fallback = experimental_useRpcKeyedQuery({
    contract: rpcContract,
    method: "threadStatuses",
    keys: missing,
    enabled: missing.length > 0,
  });

  const value = useMemo(() => {
    const map = new Map<string, ThreadView>();
    for (const id of unique) {
      const thread = live.get(id);
      if (thread) {
        map.set(id, {
          id,
          title: thread.displayTitle,
          state: threadRunStatus(thread),
          label: thread.indicatorLabel ?? null,
          href: thread.href ?? null,
        });
        continue;
      }
      const row = fallback.data?.[id];
      map.set(id, {
        id,
        title: row?.title ?? "Thread",
        state: row ? fromRpc(row.state) : "idle",
        label: null,
        href: null,
      });
    }
    return map;
  }, [unique, live, fallback.data]);

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useThreadView(threadId: string): ThreadView | null {
  return useContext(Context).get(threadId) ?? null;
}

export function useThreadViews(threadIds: string[]): ThreadView[] {
  const map = useContext(Context);
  return threadIds.flatMap((id) => {
    const view = map.get(id);
    return view ? [view] : [];
  });
}

/** The state a card shows for all its threads: needs-you beats running beats failed. */
export function summaryState(views: ThreadView[]): RunStatus | null {
  if (views.length === 0) return null;
  if (views.some((view) => view.state === "waiting")) return "waiting";
  if (views.some((view) => view.state === "running")) return "running";
  if (views.some((view) => view.state === "failed")) return "failed";
  return "idle";
}
