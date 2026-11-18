// The editor page: `/plugins/helix-bridge/editor/<threadId>`. Helix fills the
// page body; the rail (files, changes, comments) is a sheet over its left
// edge, there only while it is used; the thread's conversation is the page's
// fixed Chat tab in bb's side panel, so hiding the panel gives Helix the full
// width.
import { useEffect, useState } from "react";
import { experimental_useAppPanel as useAppPanel, experimental_usePanelTabs as usePanelTabs, ThreadChat, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { EmptyState, StatusDot } from "../../kit";
import { useInstances, useThreadHelix, whereLabel } from "../data";
import { composerFocusRequest } from "../stores";
import { useRealtime } from "@get-bb/plugin-sdk/app";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { Rail } from "../rail/Rail";
import { editorFocus, pendingTreeReveal, railFocus, railSheet, railTab, useRailSheet } from "../rail/railStore";
import { EditorSurface } from "../surface/EditorSurface";
import { ReviewBar } from "../review/ReviewBar";
import { usePageActions } from "./pageActions";

export const EDITOR_PANEL = "editor";

export function threadFromSubPath(subPath: string): string | null {
  const first = subPath.split("/")[0];
  if (!first) return null;
  const decoded = decodeURIComponent(first);
  return /^[A-Za-z0-9_-]{1,64}$/u.test(decoded) ? decoded : null;
}

export function EditorPage({ subPath }: { subPath: string }) {
  const threadId = threadFromSubPath(subPath);
  const navigate = useBbNavigate();
  useEditorWidth(threadId);
  usePageActions(threadId);
  if (!threadId) return <PickThread />;
  // Helix closed: back to the thread, with its composer focused.
  const onClosed = () => {
    composerFocusRequest.set({ threadId, at: Date.now() });
    navigate.toThread(threadId);
  };
  // Keyed so switching threads mounts a fresh session.
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <ReviewBar threadId={threadId} />
      <EditorSurface key={threadId} threadId={threadId} active autoFocus onClosed={onClosed} />
      <RailSheet threadId={threadId} />
    </div>
  );
}

/**
 * The rail over the editor's left edge: opened from Helix (`space e`, the
 * `space u` keys) or the review bar, closed by Escape, a click outside, or
 * choosing a file, a change or a comment.
 */
function RailSheet({ threadId }: { threadId: string }) {
  const open = useRailSheet() === threadId;
  const portal = usePortalScopeProps();
  // :bb-files with the rail closed: it opens on Files (open, the rail itself handles it).
  useRealtime("files", (payload: unknown) => {
    const request = payload as { threadId?: string; path?: string | null } | null;
    if (request?.threadId !== threadId || railSheet.get() === threadId) return;
    railTab.set("files");
    pendingTreeReveal.set({ threadId, path: request.path ?? null, focus: true, at: Date.now() });
    railSheet.set(threadId);
  });
  useEffect(() => {
    if (!open) return;
    const timers = [0, 250, 700].map((delay) => window.setTimeout(() => railFocus.get(threadId)?.(), delay));
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [open, threadId]);
  // Leaving the page closes it: coming back, Helix has the whole page.
  useEffect(
    () => () => {
      if (railSheet.get() === threadId) railSheet.set(null);
    },
    [threadId],
  );
  if (!open) return null;
  const close = () => {
    railSheet.set(null);
    editorFocus.get(threadId)?.();
  };
  return (
    <div {...portal} className="absolute inset-0 z-30 flex" data-helix-rail-sheet>
      <div className="flex h-full w-[min(22rem,88%)] flex-col border-r border-border/60 bg-background pt-2 shadow-lg motion-safe:animate-[helix-flyout-in_200ms_cubic-bezier(0.22,1,0.36,1)]">
        <Rail threadId={threadId} onLeave={() => railSheet.set(null)} />
      </div>
      <button type="button" aria-label="Close the rail" className="min-w-0 flex-1 cursor-default bg-transparent" onClick={close} tabIndex={-1} />
    </div>
  );
}

/** Helix needs this many columns to be comfortable. */
const COMFORTABLE_COLUMNS = 80;
/** On a first visit, how long after Helix's first frame the panel is still watched. */
const SETTLE_FIRST_VISIT_MS = 3000;

/** A window's width class: what the owner chose for the chat is remembered per class. */
export function widthClass(width: number): "narrow" | "medium" | "wide" {
  return width < 1100 ? "narrow" : width < 1700 ? "medium" : "wide";
}

/**
 * The first time the editor opens in a width class, the chat panel closes when
 * leaving it open would give Helix fewer than 80 columns. After that the
 * owner's own choice (opening or closing the panel here) is kept per class.
 */
function useEditorWidth(threadId: string | null) {
  const panel = useAppPanel();
  const tabs = usePanelTabs();
  // Nothing is remembered until the first decision for this visit is made.
  const [decided, setDecided] = useState(false);
  useEffect(() => {
    if (!threadId) return;
    setDecided(false);
    const key = `helix-bridge.chat.${widthClass(window.innerWidth)}`;
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(key);
    } catch {
      // not remembered
    }
    if (stored === "closed") panel.close();
    if (stored !== null) {
      setDecided(true);
      return;
    }
    // First visit in this class: decide from the columns Helix gets once it
    // has drawn, and keep deciding for a moment, since bb may restore the
    // panel after Helix's first frame.
    let frame = 0;
    const started = performance.now();
    let drawnAt = 0;
    const check = () => {
      const now = performance.now();
      const cols = Number(document.querySelector<HTMLElement>("[data-helix-terminal]")?.dataset.cols);
      if (cols > 0) {
        drawnAt ||= now;
        if (cols < COMFORTABLE_COLUMNS && panel.getTabs().open) panel.close();
      }
      if ((drawnAt && now - drawnAt > SETTLE_FIRST_VISIT_MS) || now - started > 15_000) {
        setDecided(true);
        return;
      }
      frame = requestAnimationFrame(check);
    };
    check();
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);
  // From then on, what the owner does with the panel here is their choice for this width class.
  const open = tabs.open;
  useEffect(() => {
    if (!threadId || !decided) return;
    const timer = window.setTimeout(() => {
      try {
        window.localStorage.setItem(`helix-bridge.chat.${widthClass(window.innerWidth)}`, open ? "open" : "closed");
      } catch {
        // not remembered
      }
    }, 600);
    return () => window.clearTimeout(timer);
  }, [open, threadId, decided]);
}

/** The page header: where Helix is and what it reports. The thread and the other editors are at the top of the rail. */
export function EditorHeader({ subPath }: { subPath: string }) {
  const threadId = threadFromSubPath(subPath);
  const { data, position } = useThreadHelix(threadId);
  const instance = data?.instance ?? null;
  const where = position ? whereLabel(position.path, position.line, position.endLine) : whereLabel(instance?.focus?.path, instance?.focus?.line, instance?.focus?.endLine);
  if (!threadId) return null;
  return (
    <div className="flex min-w-0 max-w-[min(60vw,48rem)] items-center gap-3 text-xs">
      {instance ? (
        <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground" title={instance.status === "connected" ? "Helix is connected" : `Helix is ${instance.status}`}>
          <StatusDot status={instance.status === "connected" ? "running" : "failed"} />
          {where ? <span className="min-w-0 truncate font-mono text-foreground" title={where}>{where}</span> : null}
          {instance.diagnostics.errors > 0 ? <span className="shrink-0 tabular-nums text-destructive">{instance.diagnostics.errors} errors</span> : null}
          {instance.diagnostics.warnings > 0 ? <span className="hidden shrink-0 tabular-nums sm:inline">{instance.diagnostics.warnings} warnings</span> : null}
        </span>
      ) : null}
    </div>
  );
}

/** No thread in the URL: the threads that have a Helix, or how to open one. */
function PickThread() {
  const { data, loading } = useInstances();
  const navigate = useBbNavigate();
  const bound = (data?.instances ?? []).filter((i) => i.threadId);
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      {bound.length === 0 ? (
        <EmptyState
          icon="Code"
          title={loading ? "Looking for Helix" : "Open Helix from a thread"}
          description="Each thread has its own editor in its workspace. Use the Helix button in a thread's header, or the palette: Helix: open the editor for this thread."
        />
      ) : (
        <div className="w-full max-w-md space-y-2">
          <h2 className="text-sm font-medium">Threads with a connected Helix</h2>
          <ul className="space-y-1">
            {bound.map((i) => (
              <li key={i.key}>
                <button
                  type="button"
                  className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => navigate.toPluginPanel(EDITOR_PANEL, { subPath: i.threadId! })}
                >
                  <Icon name="Code" className="size-4 text-muted-foreground" />
                  <span className="truncate">{i.threadTitle ?? i.threadId}</span>
                  <span className={cn("ml-auto truncate font-mono text-xs text-muted-foreground")}>{whereLabel(i.focus?.path, i.focus?.line) ?? ""}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** The page's fixed side-panel tab: the thread's conversation. */
export function ChatTab({ subPath }: { subPath: string }) {
  const threadId = threadFromSubPath(subPath);
  if (!threadId) return <EmptyState icon="MessageSquare" title="No thread" description="Open the editor from a thread to chat beside it." />;
  // Escape in the chat goes back to Helix, once bb has had its own use of it
  // (closing a menu, a dialog).
  return (
    <div
      className="contents"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing) return;
        if (document.querySelector("[role='listbox'], [role='menu'], [role='dialog']")) return;
        editorFocus.get(threadId)?.();
      }}
    >
      <ThreadChat key={threadId} threadId={threadId} variant="compact" />
    </div>
  );
}
