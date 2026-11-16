// Typed live RPC reads and writes over the plugin's contract.
import {
  experimental_useRpcMutation as useRpcMutation,
  experimental_useRpcQuery as useRpcQuery,
  experimental_usePluginId as usePluginId,
} from "@get-bb/plugin-sdk/app";
import { useEffect, useState } from "react";
import { rpcContract } from "../src/contract";
import type { View } from "../src/schemas";
import type { ListSource } from "./logic";

export const PANEL_PATH = "issues";
export const PANEL_ID = "issues";

export function useStatus() {
  return useRpcQuery({ contract: rpcContract, method: "status", input: null });
}

export function useViews() {
  return useRpcQuery({ contract: rpcContract, method: "views.list", input: null });
}

export function useIssueList(source: ListSource, limit: number, enabled = true) {
  return useRpcQuery({
    contract: rpcContract,
    method: "issues.list",
    input: source.kind === "view" ? { viewId: source.viewId, limit } : { jql: source.jql, limit },
    enabled,
  });
}

export function useIssue(key: string | null) {
  return useRpcQuery({
    contract: rpcContract,
    method: "issue.get",
    input: { key: key ?? "X-1" },
    enabled: key !== null,
  });
}

export function useThreadIssues(threadId: string) {
  return useRpcQuery({ contract: rpcContract, method: "thread.issues", input: { threadId } });
}

export function useRefresh() {
  return useRpcMutation({ contract: rpcContract, method: "refresh" });
}

export function useCheckConnection() {
  return useRpcMutation({ contract: rpcContract, method: "checkConnection" });
}

export function useThreadLink() {
  return useRpcMutation({ contract: rpcContract, method: "thread.link" });
}

export function useAddToTaskBoard() {
  return useRpcMutation({ contract: rpcContract, method: "addToTaskBoard" });
}

/** View writes predict `views.list` so the sidebar changes on the action. */
export function useViewMutations() {
  const create = useRpcMutation({
    contract: rpcContract,
    method: "views.create",
    optimistic(input, cache) {
      cache.update("views.list", null, (current) => ({
        views: [
          ...current.views,
          {
            id: `pending:${input.name}`,
            name: input.name.trim(),
            jql: input.jql.trim(),
            position: Number.MAX_SAFE_INTEGER,
            builtin: false,
          },
        ],
      }));
    },
  });
  const update = useRpcMutation({
    contract: rpcContract,
    method: "views.update",
    optimistic(input, cache) {
      cache.update("views.list", null, (current) => ({
        views: current.views.map((view) =>
          view.id === input.id
            ? {
                ...view,
                ...(input.name !== undefined ? { name: input.name.trim() } : {}),
                ...(input.jql !== undefined ? { jql: input.jql.trim() } : {}),
              }
            : view,
        ),
      }));
    },
  });
  const remove = useRpcMutation({
    contract: rpcContract,
    method: "views.delete",
    optimistic(input, cache) {
      cache.update("views.list", null, (current) => ({
        views: current.views.filter((view) => view.id !== input.id),
      }));
    },
  });
  const reorder = useRpcMutation({
    contract: rpcContract,
    method: "views.reorder",
    optimistic(input, cache) {
      cache.update("views.list", null, (current) => ({ views: orderViews(current.views, input.ids) }));
    },
  });
  return { create, update, remove, reorder };
}

/** Listed ids first in that order, the rest after in their current order. */
export function orderViews(views: readonly View[], ids: readonly string[]): View[] {
  const byId = new Map(views.map((view) => [view.id, view]));
  const first = ids.map((id) => byId.get(id)).filter((view): view is View => view !== undefined);
  const rest = views.filter((view) => !ids.includes(view.id));
  return [...first, ...rest].map((view, index) => ({ ...view, position: index + 1 }));
}

/** Move one id by `delta` places; returns the new id order. */
export function moveViewId(ids: readonly string[], id: string, delta: number): string[] {
  const index = ids.indexOf(id);
  if (index === -1) return [...ids];
  const target = Math.max(0, Math.min(ids.length - 1, index + delta));
  const next = [...ids];
  next.splice(index, 1);
  next.splice(target, 0, id);
  return next;
}

/** The list source the user last looked at, so `/issues/<KEY>` keeps its list. */
export function useLastSource(): [ListSource | null, (source: ListSource) => void] {
  const pluginId = usePluginId();
  const storageKey = `${pluginId}:last-source`;
  const [value, setValue] = useState<ListSource | null>(() => readSource(storageKey));
  useEffect(() => setValue(readSource(storageKey)), [storageKey]);
  const save = (source: ListSource) => {
    setValue(source);
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(source));
    } catch {
      // Storage full or blocked: the default view is fine.
    }
  };
  return [value, save];
}

function readSource(key: string): ListSource | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ListSource;
    if (parsed.kind === "view" && typeof parsed.viewId === "string") return parsed;
    if (parsed.kind === "search" && typeof parsed.jql === "string") return parsed;
  } catch {
    // Ignore a corrupt entry.
  }
  return null;
}

/** A clock that ticks every minute, for relative ages. */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}
