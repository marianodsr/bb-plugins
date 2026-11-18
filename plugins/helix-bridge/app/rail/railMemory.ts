// What each thread's rail was showing when it closed, so opening it again
// lands where it was: the row under the cursor in Changes and in Comments and
// each list's filters, and the file tree's open folders, cursor and what waits
// to be pasted. (The tab is railStore's.) The
// rail unmounts when it closes, and the page when you leave it, so this lives
// here. It is kept for the life of the window, not across a reload.
import { useMemo, useRef, useState } from "react";

export interface RailMemory {
  changes: { row: string | null; unviewedOnly: boolean; collapsed: Set<string> | null };
  comments: { row: string | null; showDone: boolean };
  /** The file tree (app/files): kept by path, so the same row comes back even if the folders changed. */
  files: {
    open: Set<string>;
    cursor: string | null;
    showHidden: boolean;
    /** Where the list was scrolled; null centres the cursor. */
    scroll: number | null;
    /** Copied or cut, waiting for a paste. */
    clip: { mode: "copy" | "move"; paths: string[] } | null;
  };
}

const memories = new Map<string, RailMemory>();

export function railMemory(threadId: string): RailMemory {
  let memory = memories.get(threadId);
  if (!memory) {
    memory = { changes: { row: null, unviewedOnly: false, collapsed: null }, comments: { row: null, showDone: false }, files: { open: new Set(), cursor: null, showHidden: false, scroll: null, clip: null } };
    memories.set(threadId, memory);
  }
  return memory;
}

/**
 * A list cursor that knows what it is on, not where: the row's key. When the
 * list changes under it, or the rail opens again, it is on the same row; a
 * row that is gone leaves it at the same place in the list.
 */
export function useKeyedCursor<T>(rows: readonly T[], keyOf: (row: T) => string, remembered: string | null, remember: (key: string) => void): { at: number; setAt(index: number): void } {
  const [key, setKey] = useState(remembered);
  const last = useRef(0);
  const found = useMemo(() => (key === null ? -1 : rows.findIndex((row) => keyOf(row) === key)), [rows, key]); // eslint-disable-line react-hooks/exhaustive-deps
  const at = found >= 0 ? found : Math.min(last.current, Math.max(0, rows.length - 1));
  // Nothing listed yet (still loading) is not a place to remember.
  if (rows.length > 0) last.current = at;
  const setAt = (index: number) => {
    const row = rows[index];
    if (row === undefined) return;
    const next = keyOf(row);
    last.current = index;
    setKey(next);
    remember(next);
  };
  return { at, setAt };
}
