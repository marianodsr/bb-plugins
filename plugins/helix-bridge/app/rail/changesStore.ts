// One `changes` read per thread, shared by everything on screen that shows
// the review (the rail, the review bar, the header count): a single request in
// flight, refetched when the server says the review changed. Nothing reads
// while nothing that shows it is mounted.
import { useEffect, useSyncExternalStore } from "react";
import { useRealtime, useRealtimeConnectionState } from "@get-bb/plugin-sdk/app";
import type { ChangedFile } from "../../server";
import { useHelixRpc, type Rpc } from "../data";

export type ChangesData = {
  capable: boolean;
  connected: boolean;
  review: {
    id: string;
    title: string;
    scope: "uncommitted" | "branch" | "pr" | "commit";
    sha: string | null;
    files: ChangedFile[];
    truncated: boolean;
    additions: number;
    deletions: number;
    inline: boolean | null;
  } | null;
  error: string | null;
  hasPullRequest: boolean;
};

interface Entry {
  data: ChangesData | undefined;
  error: string | null;
  loading: boolean;
  inFlight: Promise<void> | null;
  again: boolean;
  users: number;
  listeners: Set<() => void>;
  /** Optimistic viewed marks, until a read confirms them. */
  viewed: Map<string, boolean>;
  snapshot: Snapshot;
}

export interface Snapshot {
  data: ChangesData | undefined;
  error: string | null;
  loading: boolean;
}

const entries = new Map<string, Entry>();

function entryFor(threadId: string): Entry {
  let entry = entries.get(threadId);
  if (!entry) {
    entry = { data: undefined, error: null, loading: true, inFlight: null, again: false, users: 0, listeners: new Set(), viewed: new Map(), snapshot: { data: undefined, error: null, loading: true } };
    entries.set(threadId, entry);
  }
  return entry;
}

function publish(entry: Entry): void {
  let data = entry.data;
  if (data?.review && entry.viewed.size > 0) {
    data = { ...data, review: { ...data.review, files: data.review.files.map((f) => (entry.viewed.has(f.path) ? { ...f, viewed: entry.viewed.get(f.path)! } : f)) } };
  }
  entry.snapshot = { data, error: entry.error, loading: entry.loading };
  for (const l of entry.listeners) l();
}

function load(rpc: Rpc, threadId: string): Promise<void> {
  const entry = entryFor(threadId);
  if (entry.inFlight) {
    entry.again = true;
    return entry.inFlight;
  }
  entry.inFlight = rpc
    .call("changes", { threadId })
    .then(
      (data) => {
        entry.data = data as ChangesData;
        entry.error = null;
        // Confirmed marks replace the predictions.
        for (const f of data.review?.files ?? []) if (entry.viewed.get(f.path) === f.viewed) entry.viewed.delete(f.path);
      },
      (cause: unknown) => {
        entry.error = cause instanceof Error ? cause.message : String(cause);
      },
    )
    .finally(() => {
      entry.loading = false;
      entry.inFlight = null;
      publish(entry);
      if (entry.again) {
        entry.again = false;
        void load(rpc, threadId);
      }
    });
  return entry.inFlight;
}

/** The thread's review as the rail shows it. */
export function useChanges(threadId: string): Snapshot & { refetch(): void } {
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
  useRealtime("review", (payload: unknown) => {
    const changed = (payload as { threadId?: string | null } | null)?.threadId;
    if (changed === threadId || changed === null) refetch();
  });
  useRealtime("instances", refetch);
  const connection = useRealtimeConnectionState();
  useEffect(() => {
    if (connection === "connected" && entry.data) refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection]);
  return { ...snapshot, refetch };
}

/** Mark a file viewed or not at once; the server writes bb's mark behind it. */
export function setViewedOptimistic(rpc: Rpc, threadId: string, path: string, viewed: boolean): Promise<void> {
  const entry = entryFor(threadId);
  entry.viewed.set(path, viewed);
  publish(entry);
  return rpc.call("setViewed", { threadId, path, viewed }).then(
    () => load(rpc, threadId),
    (cause: unknown) => {
      // Back to what it was, and say why.
      entry.viewed.delete(path);
      entry.error = cause instanceof Error ? cause.message : String(cause);
      publish(entry);
    },
  );
}

/** Patches by path and revision: a file's diff is fetched once until it changes. */
const patches = new Map<string, Promise<{ patch: string | null; truncated: boolean; message: string | null }>>();
export function patchFor(rpc: Rpc, threadId: string, path: string, revision: string) {
  const key = `${threadId}\u0000${path}\u0000${revision}`;
  let pending = patches.get(key);
  if (!pending) {
    pending = rpc.call("filePatch", { threadId, path, revision });
    pending.catch(() => patches.delete(key));
    patches.set(key, pending);
    if (patches.size > 400) patches.delete(patches.keys().next().value!);
  }
  return pending;
}
