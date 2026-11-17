// What the editor page and its rail (in bb's sidebar) share. They are two
// React trees bb mounts separately, so they meet here: the rail asks the
// editor for focus, the editor asks the rail to show a tab, and both read
// which tab is showing. Nothing here re-renders on a cursor move.
import { useSyncExternalStore } from "react";

export type RailTab = "files" | "changes" | "comments";

type Listener = () => void;
function store<T>(initial: T) {
  let value = initial;
  const listeners = new Set<Listener>();
  return {
    get: () => value,
    set(next: T) {
      if (Object.is(next, value)) return;
      value = next;
      for (const l of listeners) l();
    },
    subscribe(l: Listener) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

const TAB_KEY = "helix-bridge.rail.tab";

function storedTab(): RailTab {
  try {
    const value = window.localStorage.getItem(TAB_KEY);
    return value === "changes" || value === "comments" ? value : "files";
  } catch {
    return "files";
  }
}

/** The rail's tab; remembered in this browser. */
export const railTab = store<RailTab>(storedTab());
railTab.subscribe(() => {
  try {
    window.localStorage.setItem(TAB_KEY, railTab.get());
  } catch {
    // not remembered
  }
});

export function useRailTab(): RailTab {
  return useSyncExternalStore(railTab.subscribe, railTab.get);
}

/** Per thread: give Helix the keyboard. Registered by the editor surface. */
export const editorFocus = new Map<string, () => void>();

/** Per thread: give the rail the keyboard (its current tab). Registered by the rail. */
export const railFocus = new Map<string, () => boolean>();

/** Per thread: the rail holds focus now. */
export const railHasFocus = new Map<string, () => boolean>();

/** The rail as a sheet over the editor, for when bb's sidebar is collapsed or a closed drawer. */
export const railSheet = store<string | null>(null);
export function useRailSheet(): string | null {
  return useSyncExternalStore(railSheet.subscribe, railSheet.get);
}

/**
 * The rail in bb's sidebar can be used now: drawn, in the window, and not in
 * bb's closed drawer (compact windows keep it mounted there, inert).
 */
export function sidebarRailVisible(threadId: string): boolean {
  const el = document.querySelector<HTMLElement>(`[data-helix-sidebar-rail="${CSS.escape(threadId)}"]`);
  if (!el || el.closest("[inert]")) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.right > 0 && r.left < window.innerWidth;
}

/** A tree reveal asked for before the tree was on screen (`:bb-files`). */
export const pendingTreeReveal = store<{ threadId: string; path: string | null; focus: boolean; at: number } | null>(null);
