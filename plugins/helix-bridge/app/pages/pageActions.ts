// The editor page's actions, one name each, whatever asks for them: bb's
// palette and Cmd keys (app.tsx) and Helix's `:bb-emit <name>` (bound to
// whatever key the owner likes). The page registers what it can do; the
// commands are available only while a page is on screen.
import { useEffect, useRef } from "react";
import { experimental_useAppPanel as useAppPanel, useRealtime } from "@get-bb/plugin-sdk/app";
import type { ChangedFile } from "../../server";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { useHelixRpc, useThreadHelix } from "../data";
import { setViewedOptimistic, useChanges } from "../rail/changesStore";
import { editorFocus, railFocus, railHasFocus, railSheet, railTab, sidebarRailVisible, type RailTab } from "../rail/railStore";
import { sendComments } from "../review/SendToThread";

/** The editor page's panel id (EditorPage's EDITOR_PANEL; repeated here to keep imports one-way). */
const EDITOR_PANEL = "editor";

export const ACTIONS = {
  "review.next-file": "Next changed file",
  "review.prev-file": "Previous changed file",
  "review.viewed": "Mark this file viewed and go to the next",
  "review.send": "Send to thread",
  "rail.files": "Files",
  "rail.changes": "Changes",
  "rail.comments": "Comments",
  "chat.focus": "Focus the chat",
} as const;
export type ActionName = keyof typeof ACTIONS;

/** Per thread: run an action on that thread's editor page. */
export const pageActions = new Map<string, (name: string, args: string[]) => void>();

/** The review's files in the rail's order: by folder, then by path. */
export function orderedFiles(files: readonly ChangedFile[]): ChangedFile[] {
  const dir = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
  return [...files].sort((a, b) => {
    const da = dir(a.path);
    const db = dir(b.path);
    if (da === "" && db !== "") return -1;
    if (db === "" && da !== "") return 1;
    return da.localeCompare(db) || a.path.localeCompare(b.path);
  });
}

export function usePageActions(threadId: string | null) {
  const rpc = useHelixRpc();
  const panel = useAppPanel();
  const scope = usePortalScopeProps() as unknown as Record<string, string>;
  const { data } = useChanges(threadId ?? "");
  const helix = useThreadHelix(threadId);
  const latest = useRef({ data, helix });
  latest.current = { data, helix };

  useEffect(() => {
    if (!threadId) return;
    const showTab = (tab: RailTab) => {
      railTab.set(tab);
      if (sidebarRailVisible(threadId)) window.setTimeout(() => railFocus.get(threadId)?.(), 0);
      else railSheet.set(threadId);
    };
    /** Helix's file, relative to the workspace, as the review lists it. */
    const currentPath = () => {
      const { helix: h } = latest.current;
      return h.position?.path ?? h.data?.instance?.focus?.path ?? null;
    };
    const step = async (delta: 1 | -1, onlyUnviewed = false) => {
      let listed = latest.current.data?.review?.files ?? null;
      if (!latest.current.data?.review) {
        // No review yet: the same one the Changes tab would start.
        await rpc.call("startReview", { threadId, target: "auto" }).catch(() => null);
        listed = (await rpc.call("changes", { threadId }).catch(() => null))?.review?.files ?? null;
      }
      const files = orderedFiles(listed ?? []).filter((f) => f.status !== "deleted");
      if (files.length === 0) {
        void rpc.call("notifyHelix", { threadId, message: "No changed files to go to" }).catch(() => {});
        return;
      }
      const at = files.findIndex((f) => f.path === currentPath());
      const pool = onlyUnviewed ? files.filter((f) => !f.viewed) : files;
      if (pool.length === 0) return;
      let next: ChangedFile | undefined;
      if (at < 0) next = delta > 0 ? pool[0] : pool[pool.length - 1];
      else {
        const ordered = delta > 0 ? [...files.slice(at + 1), ...files.slice(0, at + 1)] : [...files.slice(0, at).reverse(), ...files.slice(at).reverse()];
        next = ordered.find((f) => pool.includes(f) && f.path !== files[at]!.path) ?? undefined;
      }
      if (!next) {
        if (onlyUnviewed) void rpc.call("notifyHelix", { threadId, message: "Every changed file is viewed" }).catch(() => {});
        return;
      }
      void rpc.call("openChange", { threadId, path: next.path }).catch(() => {});
      editorFocus.get(threadId)?.();
    };
    const run = (name: string) => {
      switch (name) {
        case "review.next-file":
          return void step(1);
        case "review.prev-file":
          return void step(-1);
        case "review.viewed": {
          const path = currentPath();
          const file = latest.current.data?.review?.files.find((f) => f.path === path);
          if (file && !file.viewed) void setViewedOptimistic(rpc, threadId, file.path, true);
          return void step(1, true);
        }
        case "review.send":
          return void sendComments(rpc, threadId, scope);
        case "rail.files":
        case "rail.changes":
        case "rail.comments":
        case "rail.notes":
          return showTab(name === "rail.notes" ? "comments" : (name.slice(5) as RailTab));
        case "rail.toggle":
          if (railHasFocus.get(threadId)?.()) {
            if (railSheet.get() === threadId) railSheet.set(null);
            return editorFocus.get(threadId)?.();
          }
          return showTab(railTab.get());
        case "chat.focus": {
          panel.openTab({ tab: { id: "chat", context: { kind: "nav-panel", panelId: EDITOR_PANEL }, availability: "fixed" } });
          // The chat's composer once it is drawn.
          for (const delay of [0, 120, 400]) {
            window.setTimeout(() => {
              const composer = Array.from(document.querySelectorAll<HTMLElement>("[contenteditable='true']")).find((el) => !el.closest("[data-helix-rail], [data-helix-comment-box]") && el.getBoundingClientRect().width > 0);
              if (composer && !composer.contains(document.activeElement)) composer.focus();
            }, delay);
          }
          return;
        }
        default:
          void rpc.call("notifyHelix", { threadId, message: `Unknown action ${name}: see the Helix Bridge README for the list` }).catch(() => {});
      }
    };
    const handler = (name: string) => run(name);
    pageActions.set(threadId, handler);
    return () => {
      if (pageActions.get(threadId) === handler) pageActions.delete(threadId);
    };
  }, [threadId, rpc, panel, scope]);

  // :bb-emit <name> from this thread's Helix.
  useRealtime("action", (payload: unknown) => {
    const message = payload as { threadId?: string; name?: string; args?: string[] } | null;
    if (!threadId || message?.threadId !== threadId || !message.name) return;
    pageActions.get(threadId)?.(message.name, message.args ?? []);
  });
}
