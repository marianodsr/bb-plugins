// View state shared by the page body and its header (separate React trees).
import { useSyncExternalStore } from "react";
import { NO_FILTERS, type Filters } from "./model";

export type ViewMode = "board" | "list";

export interface ViewState {
  /** A project id, "all", or null while the default is being resolved. */
  scope: string | null;
  view: ViewMode;
  filters: Filters;
  /** The page body's width; the header sizes itself from it. */
  pageWidth: number;
}

type Listener = () => void;

let state: ViewState = { scope: null, view: readView(), filters: NO_FILTERS, pageWidth: 1200 };
const listeners = new Set<Listener>();
let searchFocus: (() => void) | null = null;

function readView(): ViewMode {
  try {
    return globalThis.localStorage?.getItem("task-board:view") === "list" ? "list" : "board";
  } catch {
    return "board";
  }
}

export function getView(): ViewState {
  return state;
}

export function setView(patch: Partial<ViewState>): void {
  const next = { ...state, ...patch };
  if (patch.filters) next.filters = { ...state.filters, ...patch.filters };
  state = next;
  if (patch.view) {
    try {
      globalThis.localStorage?.setItem("task-board:view", patch.view);
    } catch {
      // Private mode: the choice lasts for the session.
    }
  }
  for (const listener of listeners) listener();
}

export function setFilters(patch: Partial<Filters>): void {
  setView({ filters: { ...state.filters, ...patch } });
}

export function useView(): ViewState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getView,
    getView,
  );
}

/** The header's search field registers itself so `/` works from the board. */
export function registerSearch(focus: (() => void) | null): void {
  searchFocus = focus;
}

export function focusSearch(): boolean {
  if (!searchFocus) return false;
  searchFocus();
  return true;
}

const LAST_SCOPE = "task-board:scope";

export function rememberScope(scope: string): void {
  try {
    globalThis.localStorage?.setItem(LAST_SCOPE, scope);
  } catch {
    // Ignore.
  }
}

export function lastScope(): string | null {
  try {
    return globalThis.localStorage?.getItem(LAST_SCOPE) ?? null;
  } catch {
    return null;
  }
}
