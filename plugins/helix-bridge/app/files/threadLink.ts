// The tree's ThreadLink in bb: references go into the thread's own composer
// as bb's file and folder mentions (the same pills the @ menu makes), and a
// folder can start a new thread that names it. Asking, having a file written
// and the agent's trail are the server's (`filesAsk`, `agentFiles`, realtime
// `agent-files`) and come in as `server`; a question sent shows the chat.
//
// Two pieces live in bb's composers and must be registered in app.tsx
// (`app.composer.customize`) to work:
// - FilesDropBanner (scope "thread", a banner): rows dragged from the tree
//   drop onto the chat as mentions. bb's composer takes drops of threads
//   only, so without it a drag from the tree does nothing there.
// - NewThreadMentions (scope "new-thread", an action): bb's new-thread screen
//   can be opened with a prompt, but only thread, project and section tokens
//   in it become pills; this puts the folder's mention in once that composer
//   is on screen.
import { createElement, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { experimental_useAppPanel as useAppPanel, useBbNavigate, useComposer, useComposers, type PluginComposerApi } from "@get-bb/plugin-sdk/app";
import { useLiveThread } from "../../kit";
import { EDITOR_PANEL } from "../pages/EditorPage";
import { DRAG_TYPE, draggedRows, mentionParts, store } from "./handoff";
import type { Sent, ThreadLink } from "./types";

/** The server's half of the link, wired at integration. */
export type ServerLink = Pick<ThreadLink, "ask" | "write" | "agentFiles" | "onAgentFiles">;

const ok: Sent = { ok: true, error: null };

export function useBbThreadLink(threadId: string, server: ServerLink): ThreadLink {
  const thread = useLiveThread(threadId);
  const navigate = useBbNavigate();
  const panel = useAppPanel();
  const composers = useComposers();
  const latest = useRef(composers);
  latest.current = composers;
  const serverRef = useRef(server);
  serverRef.current = server;
  const title = thread?.title ?? null;
  const projectId = (thread as { projectId?: string | null } | null)?.projectId ?? null;

  return useMemo<ThreadLink>(() => {
    const showChat = () => panel.openTab({ tab: { id: "chat", context: { kind: "nav-panel", panelId: EDITOR_PANEL }, availability: "fixed" } });
    /** The thread's composer, once the chat that holds it is drawn. */
    const composer = async (): Promise<PluginComposerApi | null> => {
      for (let waited = 0; waited <= 1500; waited += 50) {
        const found = latest.current.find((c) => c.scope.kind === "thread" && c.scope.threadId === threadId);
        if (found) return found;
        await new Promise((r) => setTimeout(r, 50));
      }
      return null;
    };
    return {
      thread: { id: threadId, title },
      async mention(paths) {
        showChat();
        const target = await composer();
        if (!target) return { ok: false, error: "The chat did not open. Open it beside the editor and try again." };
        try {
          target.insert(mentionParts(paths), { at: "end" });
          target.focus();
          return ok;
        } catch (cause) {
          return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
        }
      },
      async ask(paths, text) {
        const sent = await serverRef.current.ask(paths, text);
        if (sent.ok) showChat();
        return sent;
      },
      write: (path, description) => serverRef.current.write(path, description),
      agentFiles: () => serverRef.current.agentFiles(),
      onAgentFiles: (listener) => serverRef.current.onAgentFiles(listener),
      newThread(paths) {
        pendingNewThread.set(paths);
        navigate.toCompose({ ...(projectId ? { projectId } : {}), focusPrompt: true });
      },
    };
  }, [threadId, title, projectId, navigate, panel]);
}

/** Entries waiting for the new-thread composer. */
const pendingNewThread = store<string[] | null>(null);

/** In the new-thread composer: the entries a folder's "New thread here" named, as mentions. */
export function NewThreadMentions() {
  const composer = useComposer();
  const pending = useSyncExternalStore(pendingNewThread.subscribe, pendingNewThread.get);
  useEffect(() => {
    if (!pending || composer.scope.kind !== "new-thread") return;
    pendingNewThread.set(null);
    try {
      composer.insert(mentionParts(pending), { at: "end" });
      composer.focus();
    } catch {
      // The composer went away; the entries are dropped.
    }
  }, [pending, composer]);
  return null;
}

/** In a thread's composer, while rows are dragged from the tree: a place to drop them as mentions. */
export function FilesDropBanner() {
  const composer = useComposer();
  const dragged = useSyncExternalStore(draggedRows.subscribe, draggedRows.get);
  if (!dragged || composer.scope.kind !== "thread") return null;
  const label = dragged.length === 1 ? (dragged[0]!.replace(/\/$/u, "").split("/").pop() ?? "") : `${dragged.length} entries`;
  return createElement(
    "div",
    {
      "data-helix-files-drop": "",
      onDragOver: (event: React.DragEvent) => {
        if (event.dataTransfer.types.includes(DRAG_TYPE)) event.preventDefault();
      },
      onDrop: (event: React.DragEvent) => {
        event.preventDefault();
        draggedRows.set(null);
        composer.insert(mentionParts(dragged), { at: "end" });
        composer.focus();
      },
      className: "flex h-10 items-center justify-center rounded-lg border border-dashed border-ring/60 bg-state-hover text-xs text-muted-foreground",
    },
    `Drop to mention ${label}`,
  );
}
