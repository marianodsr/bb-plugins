// Each thread's folders, as last read, in a module map: it outlives the rail
// (which unmounts when it closes), so opening it draws from here in its first
// frame. Reads are batched: every folder asked for in the same tick goes in
// one `list`, in chunks of 64. A folder changed by the tree itself (an
// optimistic create, rename, paste or trash) ignores any read that started
// before the change, so a slow old answer never undoes it.
import { useSyncExternalStore } from "react";
import type { DirListing, FilesSource } from "./types";

/** The server takes 1 to 64 folders per `list`. */
const CHUNK = 64;

interface ThreadFiles {
  dirs: Map<string, DirListing>;
  /** Folders being read now. */
  reading: Map<string, Promise<void>>;
  /** Asked for in this tick, not sent yet. */
  queued: Set<string>;
  flush: Promise<void> | null;
  /** Per folder: bumped by every local change, so older reads are dropped. */
  writes: Map<string, number>;
  error: string | null;
  version: number;
  listeners: Set<() => void>;
}

const threads = new Map<string, ThreadFiles>();

export function filesCache(threadId: string): ThreadFiles {
  let t = threads.get(threadId);
  if (!t) {
    t = { dirs: new Map(), reading: new Map(), queued: new Set(), flush: null, writes: new Map(), error: null, version: 0, listeners: new Set() };
    threads.set(threadId, t);
  }
  return t;
}

function changed(t: ThreadFiles) {
  t.version++;
  for (const l of t.listeners) l();
}

/** Re-renders when the thread's folders change; the value is a version to memo on. */
export function useFilesVersion(threadId: string): number {
  const t = filesCache(threadId);
  return useSyncExternalStore(
    (l) => {
      t.listeners.add(l);
      return () => t.listeners.delete(l);
    },
    () => t.version,
  );
}

/**
 * Read these folders (one `list` for all of them, with whatever else is asked
 * in the same tick). A folder already being read is not asked twice, unless
 * `fresh`: then it is read again after the current read, so the answer is
 * newer than whatever changed it.
 */
export function readDirs(threadId: string, source: FilesSource, dirs: Iterable<string>, fresh = false): Promise<void> {
  const t = filesCache(threadId);
  const waits: Promise<void>[] = [];
  for (const dir of dirs) {
    const current = t.reading.get(dir);
    if (current && !fresh) {
      waits.push(current);
      continue;
    }
    if (current && fresh) {
      waits.push(current.then(() => readDirs(threadId, source, [dir])));
      continue;
    }
    t.queued.add(dir);
  }
  if (t.queued.size > 0) {
    t.flush ??= Promise.resolve().then(() => send(threadId, source));
    waits.push(t.flush);
  }
  return Promise.all(waits).then(() => undefined);
}

async function send(threadId: string, source: FilesSource): Promise<void> {
  const t = filesCache(threadId);
  t.flush = null;
  const dirs = [...t.queued];
  t.queued.clear();
  const chunks: string[][] = [];
  for (let i = 0; i < dirs.length; i += CHUNK) chunks.push(dirs.slice(i, i + CHUNK));
  await Promise.all(
    chunks.map((chunk) => {
      const started = new Map(chunk.map((d) => [d, t.writes.get(d) ?? 0]));
      const request = source.list(chunk).then(
        (answer) => {
          t.error = null;
          for (const dir of chunk) {
            const listing = answer[dir];
            if (!listing || (t.writes.get(dir) ?? 0) !== started.get(dir)) continue;
            t.dirs.set(dir, listing);
          }
        },
        (cause: unknown) => {
          t.error = cause instanceof Error ? cause.message : String(cause);
          // A folder never read says why in place; one read before keeps what it had.
          for (const dir of chunk) if (!t.dirs.has(dir)) t.dirs.set(dir, { entries: [], error: t.error, truncated: false });
        },
      );
      const done = request.finally(() => {
        for (const dir of chunk) if (t.reading.get(dir) === done) t.reading.delete(dir);
        changed(t);
      });
      for (const dir of chunk) t.reading.set(dir, done);
      return done;
    }),
  );
}

/** The tree changed these folders itself. Returns what they were, to put back if the host refuses. */
export function patchDirs(threadId: string, patches: Map<string, DirListing | undefined>): Map<string, DirListing | undefined> {
  const t = filesCache(threadId);
  const before = new Map<string, DirListing | undefined>();
  for (const [dir, listing] of patches) {
    if (!before.has(dir)) before.set(dir, t.dirs.get(dir));
    t.writes.set(dir, (t.writes.get(dir) ?? 0) + 1);
    if (listing) t.dirs.set(dir, listing);
    else t.dirs.delete(dir);
  }
  changed(t);
  return before;
}

export function isReading(threadId: string, dir: string): boolean {
  return filesCache(threadId).reading.has(dir) || filesCache(threadId).queued.has(dir);
}

/** For the tests: forget every thread. */
export function resetFilesCache() {
  threads.clear();
}
