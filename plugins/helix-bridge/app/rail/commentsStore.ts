// One `comments` read per thread, shared by the Comments tab, the review bar
// and the comment box: refetched when the server says comments changed
// (Review Editor notifies every write), never on a timer.
import { useEffect, useSyncExternalStore } from "react";
import { useRealtime, useRealtimeConnectionState } from "@get-bb/plugin-sdk/app";
import type { RailComment } from "../../server";
import { useHelixRpc, type Rpc } from "../data";

export interface CommentsData {
  source: "review-editor" | "local";
  comments: RailComment[];
  unsent: number;
  needsYou: number;
}

interface Entry {
  data: CommentsData | undefined;
  error: string | null;
  inFlight: Promise<void> | null;
  again: boolean;
  users: number;
  listeners: Set<() => void>;
  /** Comments the box just kept, shown before the read confirms them. */
  added: RailComment[];
  /** Dropped or changed here, before the read confirms it. */
  hidden: Set<string>;
  snapshot: { data: CommentsData | undefined; error: string | null };
}

const entries = new Map<string, Entry>();

function entryFor(threadId: string): Entry {
  let entry = entries.get(threadId);
  if (!entry) {
    entry = { data: undefined, error: null, inFlight: null, again: false, users: 0, listeners: new Set(), added: [], hidden: new Set(), snapshot: { data: undefined, error: null } };
    entries.set(threadId, entry);
  }
  return entry;
}

function publish(entry: Entry): void {
  let data = entry.data;
  if (data && (entry.added.length > 0 || entry.hidden.size > 0)) {
    const known = new Set(data.comments.map((c) => c.id));
    const comments = [...data.comments.filter((c) => !entry.hidden.has(c.id)), ...entry.added.filter((c) => !known.has(c.id))];
    data = { ...data, comments, unsent: comments.filter((c) => c.state === "unsent").length };
  }
  entry.snapshot = { data, error: entry.error };
  for (const l of entry.listeners) l();
}

function load(rpc: Rpc, threadId: string): Promise<void> {
  const entry = entryFor(threadId);
  if (entry.inFlight) {
    entry.again = true;
    return entry.inFlight;
  }
  entry.inFlight = rpc
    .call("comments", { threadId })
    .then(
      (data) => {
        entry.data = data as CommentsData;
        entry.error = null;
        const ids = new Set(data.comments.map((c) => c.id));
        entry.added = entry.added.filter((c) => !ids.has(c.id));
        for (const id of [...entry.hidden]) if (!ids.has(id)) entry.hidden.delete(id);
      },
      (cause: unknown) => {
        entry.error = cause instanceof Error ? cause.message : String(cause);
      },
    )
    .finally(() => {
      entry.inFlight = null;
      publish(entry);
      if (entry.again) {
        entry.again = false;
        void load(rpc, threadId);
      }
    });
  return entry.inFlight;
}

export function useComments(threadId: string): { data: CommentsData | undefined; error: string | null; refetch(): void } {
  const rpc = useHelixRpc();
  const entry = entryFor(threadId);
  const snapshot = useSyncExternalStore(
    (l) => {
      entry.listeners.add(l);
      return () => entry.listeners.delete(l);
    },
    () => entry.snapshot,
  );
  useEffect(() => {
    entry.users += 1;
    if (entry.users === 1) void load(rpc, threadId);
    return () => {
      entry.users -= 1;
    };
  }, [entry, rpc, threadId]);
  const refetch = () => void load(rpc, threadId);
  useRealtime("comments", (payload: unknown) => {
    const changed = (payload as { threadId?: string | null } | null)?.threadId;
    if (changed === threadId || changed === null || changed === undefined) refetch();
  });
  const connection = useRealtimeConnectionState();
  useEffect(() => {
    if (connection === "connected" && entry.data) refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection]);
  return { ...snapshot, refetch };
}

/** Show a comment the box kept at once; the read confirms it. */
export function addOptimistic(threadId: string, comment: RailComment): void {
  const entry = entryFor(threadId);
  entry.added = [...entry.added.filter((c) => c.id !== comment.id), comment];
  publish(entry);
}

export function hideOptimistic(threadId: string, id: string, hidden: boolean): void {
  const entry = entryFor(threadId);
  if (hidden) entry.hidden.add(id);
  else entry.hidden.delete(id);
  publish(entry);
}

export function refetchComments(rpc: Rpc, threadId: string): Promise<void> {
  return load(rpc, threadId);
}
