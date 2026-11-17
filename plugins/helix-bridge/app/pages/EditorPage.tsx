// The editor page: `/plugins/helix-bridge/editor/<threadId>`. The editor
// fills the page body; the thread's conversation is the page's fixed Chat tab
// in bb's own side panel, so bb's split gives editor plus chat and hiding the
// panel gives the editor the full width.
import { useMemo } from "react";
import { ThreadChat, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { EmptyState, StatusDot, ThreadChip } from "../../kit";
import { useInstances, useThreadHelix, whereLabel } from "../data";
import { composerFocusRequest } from "../stores";
import { EditorSurface, surfaceControls } from "../surface/EditorSurface";

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
  if (!threadId) return <PickThread />;
  // Helix closed: back to the thread, with its composer focused.
  const onClosed = () => {
    composerFocusRequest.set({ threadId, at: Date.now() });
    navigate.toThread(threadId);
  };
  // Keyed so switching threads mounts a fresh session.
  return <EditorSurface key={threadId} threadId={threadId} active autoFocus tree onClosed={onClosed} />;
}

/** The page header: which thread, where Helix is, and a switcher. */
export function EditorHeader({ subPath }: { subPath: string }) {
  const threadId = threadFromSubPath(subPath);
  const { data, position } = useThreadHelix(threadId);
  const instance = data?.instance ?? null;
  const where = position ? whereLabel(position.path, position.line, position.endLine) : whereLabel(instance?.focus?.path, instance?.focus?.line, instance?.focus?.endLine);
  if (!threadId) return null;
  return (
    <div className="flex min-w-0 max-w-[min(60vw,48rem)] items-center gap-3 text-xs">
      <Button
        size="sm"
        variant="ghost"
        className="size-7 shrink-0 p-0"
        aria-label="Show or hide the file tree (⌘⇧Y)"
        onClick={() => surfaceControls.get(threadId)?.toggleTree()}
        data-helix-tree-toggle
      >
        <Icon name="Folder" className="size-4" />
      </Button>
      <ThreadChip threadId={threadId} />
      {instance ? (
        <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground" title={instance.status === "connected" ? "Helix is connected" : `Helix is ${instance.status}`}>
          <StatusDot status={instance.status === "connected" ? "running" : "failed"} />
          {where ? <span className="min-w-0 truncate font-mono text-foreground" title={where}>{where}</span> : null}
          {instance.diagnostics.errors > 0 ? <span className="shrink-0 tabular-nums text-destructive">{instance.diagnostics.errors} errors</span> : null}
          {instance.diagnostics.warnings > 0 ? <span className="hidden shrink-0 tabular-nums sm:inline">{instance.diagnostics.warnings} warnings</span> : null}
        </span>
      ) : null}
      <ThreadSwitcher current={threadId} />
    </div>
  );
}

function ThreadSwitcher({ current }: { current: string }) {
  const { data } = useInstances();
  const navigate = useBbNavigate();
  const others = useMemo(() => {
    const seen = new Set<string>([current]);
    return (data?.instances ?? []).filter((i) => i.threadId && !seen.has(i.threadId) && seen.add(i.threadId));
  }, [data, current]);
  if (others.length === 0) return null;
  return (
    <span className="flex items-center gap-1">
      {others.slice(0, 3).map((i) => (
        <Button
          key={i.key}
          size="sm"
          variant="ghost"
          className="h-7 max-w-40 px-2 text-xs"
          aria-label={`Switch to the editor of ${i.threadTitle ?? i.threadId}`}
          onClick={() => navigate.toPluginPanel(EDITOR_PANEL, { subPath: i.threadId! })}
        >
          <span className="truncate">{i.threadTitle ?? i.threadId}</span>
        </Button>
      ))}
    </span>
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
  return <ThreadChat key={threadId} threadId={threadId} variant="compact" />;
}
