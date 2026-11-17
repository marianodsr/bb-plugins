// Small shared stores: the overlay, composer banners, panel tabs and palette
// commands talk through these (no import cycles between those modules).
import { useSyncExternalStore } from "react";

type Listener = () => void;
function store<T>(initial: T) {
  let value = initial;
  const listeners = new Set<Listener>();
  return {
    get: () => value,
    set(next: T) {
      value = next;
      for (const l of listeners) l();
    },
    subscribe(l: Listener) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

/** The last draft that arrived from Helix, per thread, for the receipt. */
export const arrivals = store<ReadonlyMap<string, { summary: string; at: number }>>(new Map());
/** A thread whose composer should take focus once it is on screen (after Helix closed). */
export const composerFocusRequest = store<{ threadId: string; at: number } | null>(null);

/** What the palette asked for; the overlay has the hooks to do it. */
export const commandRequest = store<{ kind: "open" | "reload" | "bind"; threadId: string; at: number } | null>(null);

export function useArrival(threadId: string | null) {
  const map = useSyncExternalStore(arrivals.subscribe, arrivals.get);
  return threadId ? (map.get(threadId) ?? null) : null;
}

