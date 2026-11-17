// Window-level Helix work, mounted once per app window:
// - drafts from `:bb-send` land in their thread's composer as soon as that
//   composer is on screen (now, or when the thread is next opened), with the
//   handoff's packet flying from the editor when it is visible, and a
//   "From Helix" receipt over the composer;
// - an agent's helix_show / helix_tour offers to reveal the editor;
// - the palette's "bind" command opens the bind dialog.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useBbContext, useBbNavigate, useComposers, useRealtime } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { prefersReducedMotion } from "../../kit";
import { startFlight, targets } from "../../kit/handoff/flight";
import { useHelixRpc } from "../data";
import { EDITOR_PANEL, threadFromSubPath } from "../pages/EditorPage";
import { visibleSurfaces } from "../surface/EditorSurface";
import { BindDialog } from "../thread/ThreadParts";

// ----- small stores shared with composer banners and commands ---------------

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
/** What the palette asked for; the overlay has the hooks to do it. */
export const commandRequest = store<{ kind: "open" | "reload" | "bind"; threadId: string; at: number } | null>(null);

export function useArrival(threadId: string | null) {
  const map = useSyncExternalStore(arrivals.subscribe, arrivals.get);
  return threadId ? (map.get(threadId) ?? null) : null;
}

// ----- the overlay ---------------------------------------------------------

export function HelixOverlay() {
  const rpc = useHelixRpc();
  const composers = useComposers();
  const navigate = useBbNavigate();
  const context = useBbContext();
  const scope = usePortalScopeProps();
  const [nudge, setNudge] = useState(0);
  const delivering = useRef(new Set<string>());
  const request = useSyncExternalStore(commandRequest.subscribe, commandRequest.get);

  useEffect(() => {
    if (!request || request.kind === "bind") return;
    commandRequest.set(null);
    if (request.kind === "open") {
      navigate.toPluginPanel(EDITOR_PANEL, { subPath: request.threadId });
      return;
    }
    void (async () => {
      const { instance } = await rpc.call("threadStatus", { threadId: request.threadId });
      if (!instance) {
        toast("No Helix is connected to this thread");
        return;
      }
      const result = await rpc.call("reload", { instanceKey: instance.key });
      toast(
        result.skippedModified.length
          ? `Reloaded ${result.reloaded} buffers; not reloaded, unsaved changes: ${result.skippedModified.join(", ")}`
          : `Reloaded ${result.reloaded} ${result.reloaded === 1 ? "buffer" : "buffers"}`,
      );
    })().catch((error: unknown) => toast(`Reload failed: ${error instanceof Error ? error.message : String(error)}`));
  }, [request, navigate, rpc]);

  useRealtime("draft", () => setNudge((n) => n + 1));

  // Thread composers on screen, as a stable key so typing does not refetch.
  const onScreen = [...new Set(composers.flatMap((c) => (c.scope.kind === "thread" ? [c.scope.threadId] : [])))].sort().join(",");
  const composersRef = useRef(composers);
  composersRef.current = composers;

  useEffect(() => {
    for (const threadId of onScreen.split(",").filter(Boolean)) {
      if (delivering.current.has(threadId)) continue;
      delivering.current.add(threadId);
      void (async () => {
        try {
          const { drafts } = await rpc.call("drafts", { threadId });
          for (const draft of drafts) {
            const composer = composersRef.current.find((c) => c.scope.kind === "thread" && c.scope.threadId === threadId);
            if (!composer) return; // left the screen; it stays queued
            const { taken } = await rpc.call("takeDraft", { id: draft.id });
            if (!taken) continue; // another window delivered it
            const origin = visibleSurfaces.get(threadId) ?? null;
            const flight =
              origin && !prefersReducedMotion()
                ? startFlight({ sources: [], origin, target: () => targets.composer(), label: "From Helix", scope: scope as Record<string, string> })
                : null;
            composer.insert(draft.text, { at: "end", block: true });
            composer.focus();
            const next = new Map(arrivals.get());
            next.set(threadId, { summary: draft.summary, at: Date.now() });
            arrivals.set(next);
            await flight?.finished;
          }
        } catch {
          // The next nudge or mount retries; drafts stay queued on the server.
        } finally {
          delivering.current.delete(threadId);
        }
      })();
    }
  }, [onScreen, nudge, rpc, scope]);

  useRealtime("reveal", (payload: unknown) => {
    const threadId = (payload as { threadId?: unknown } | null)?.threadId;
    if (typeof threadId !== "string") return;
    const onEditor = location.pathname.startsWith(`/plugins/helix-bridge/${EDITOR_PANEL}/`) && threadFromSubPath(location.pathname.split(`/${EDITOR_PANEL}/`)[1] ?? "") === threadId;
    if (onEditor || visibleSurfaces.has(threadId)) return;
    if (context.threadId !== threadId) return; // only for the thread on screen
    toast("The agent is showing you a place in Helix", {
      id: `helix-reveal-${threadId}`,
      action: { label: "Show", onClick: () => navigate.toPluginPanel(EDITOR_PANEL, { subPath: threadId }) },
    });
  });

  return request?.kind === "bind" ? <BindDialog threadId={request.threadId} open onOpenChange={(open) => !open && commandRequest.set(null)} /> : null;
}
