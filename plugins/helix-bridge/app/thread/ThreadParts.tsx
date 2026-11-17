// Helix on a thread: the quick-look panel tab, the status rows in the thread
// context card, and the dialog that binds a thread to a running instance.
import { useState } from "react";
import {
  experimental_ThreadContextCardRow as ThreadContextCardRow,
  experimental_useTabVisible as useTabVisible,
  experimental_useThreadContextKind as useThreadContextKind,
  experimental_useAppPanel as useAppPanel,
  experimental_usePanelTabs as usePanelTabs,
  useBbNavigate,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { EmptyState, StatusDot } from "../../kit";
import { useHelixRpc, useInstances, useReviewSummaries, useThreadHelix, whereLabel } from "../data";
import { railTab } from "../rail/railStore";
import { EDITOR_PANEL } from "../pages/EditorPage";
import { composerFocusRequest } from "../stores";
import { EditorSurface } from "../surface/EditorSurface";

/** The thread's Helix tab: the same session, for a quick look. */
export function HelixTab({ threadId }: { threadId: string }) {
  const visible = useTabVisible();
  const navigate = useBbNavigate();
  const panel = useAppPanel();
  const tabs = usePanelTabs();
  // Helix closed: close this tab (bb shows the panel's previous tab, or
  // closes the panel when this was its only one) and focus the composer.
  const onClosed = () => {
    const mine = tabs.tabs.find((t) => t.detail.kind === "plugin" && t.detail.pluginId === "helix-bridge" && t.detail.tab.id === "helix");
    if (mine) panel.closeTab(mine.key);
    composerFocusRequest.set({ threadId, at: Date.now() });
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center justify-end gap-2 border-b border-border/60 px-2">
        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => navigate.toPluginPanel(EDITOR_PANEL, { subPath: threadId })}>
          <Icon name="Maximize2" className="size-3.5" />
          Open full editor
        </Button>
      </div>
      <EditorSurface threadId={threadId} active={visible} onClosed={onClosed} />
    </div>
  );
}

const BINDING = { terminal: "started in this thread's terminal", explicit: "bound by you", environment: "latest thread in its workspace" } as const;

/** Rows in the thread context card: status and where the user is, live. */
export function HelixStatusRow({ threadId }: { threadId: string }) {
  const { data, position } = useThreadHelix(threadId);
  const summary = useReviewSummaries([threadId])[threadId] ?? null;
  const navigate = useBbNavigate();
  const [binding, setBinding] = useState(false);
  const instance = data?.instance ?? null;
  if (!instance) {
    if (!data || data.candidates === 0) return null;
    return (
      <>
        <ThreadContextCardRow icon="Code" label="Helix not bound" trailing={<span className="text-xs text-muted-foreground">{data.candidates} running</span>} onClick={() => setBinding(true)} title="Bind a running Helix to this thread" />
        <BindDialog threadId={threadId} open={binding} onOpenChange={setBinding} />
      </>
    );
  }
  const where = position ? whereLabel(position.path, position.line, position.endLine) : whereLabel(instance.focus?.path, instance.focus?.line, instance.focus?.endLine);
  const connected = instance.status === "connected";
  const counts = [instance.diagnostics.errors ? `${instance.diagnostics.errors} errors` : null, instance.diagnostics.warnings ? `${instance.diagnostics.warnings} warnings` : null].filter(Boolean).join(", ");
  return (
    <>
      <ThreadContextCardRow
        icon="Code"
        label={<span className="truncate font-mono">{connected ? (where ?? "No file open") : `Helix ${instance.status}`}</span>}
        trailing={counts ? <span className={instance.diagnostics.errors ? "text-xs tabular-nums text-destructive" : "text-xs tabular-nums text-muted-foreground"}>{counts}</span> : undefined}
        title={`Helix pid ${instance.pid}, ${instance.bindingSource ? BINDING[instance.bindingSource] : "not bound"}${instance.commandPolicy ? `, command policy ${instance.commandPolicy}` : ""}. Open the editor.`}
        onClick={() => navigate.toPluginPanel(EDITOR_PANEL, { subPath: threadId })}
        action={
          <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => setBinding(true)}>
            Change
          </Button>
        }
      />
      {summary ? (
        <ThreadContextCardRow
          icon="GitCompare"
          label={<span className="truncate">Changes: {[`${summary.files} ${summary.files === 1 ? "file" : "files"}`, summary.unviewed > 0 ? `${summary.unviewed} to view` : "all viewed", summary.needsYou > 0 ? `${summary.needsYou} ${summary.needsYou === 1 ? "comment needs" : "comments need"} you` : summary.unsent > 0 ? `${summary.unsent} ${summary.unsent === 1 ? "comment" : "comments"} not sent` : null].filter(Boolean).join(", ")}</span>}
          title={`${summary.title}. Open the editor on its changes.`}
          onClick={() => {
            railTab.set(summary.needsYou > 0 ? "comments" : "changes");
            navigate.toPluginPanel(EDITOR_PANEL, { subPath: threadId });
          }}
        />
      ) : null}
      {instance.skippedModified.length > 0 ? (
        <ThreadContextCardRow icon="AlertTriangle" label={<span className="truncate">Not reloaded: {instance.skippedModified.join(", ")}</span>} title="These buffers have unsaved changes in Helix, so the agent's edits were not loaded into them. Save or reload them in Helix." />
      ) : null}
      <BindDialog threadId={threadId} open={binding} onOpenChange={setBinding} />
    </>
  );
}

/** Pick which running Helix this thread uses. */
export function BindDialog({ threadId, open, onOpenChange }: { threadId: string; open: boolean; onOpenChange(open: boolean): void }) {
  const rpc = useHelixRpc();
  const { data, refetch } = useInstances();
  const [error, setError] = useState<string | null>(null);
  const instances = data?.instances ?? [];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Bind Helix to this thread</DialogTitle>
          <DialogDescription>Sends from that Helix go to this thread, and this thread's agent works with it.</DialogDescription>
        </DialogHeader>
        {instances.length === 0 ? (
          <EmptyState icon="Code" title="No Helix is running" description="Start hxb in any terminal on this machine, then bind it here." />
        ) : (
          <ul className="space-y-1">
            {instances.map((i) => {
              const current = i.threadId === threadId;
              return (
                <li key={i.key}>
                  <button
                    type="button"
                    disabled={current}
                    className="flex min-h-11 w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 disabled:hover:bg-transparent"
                    onClick={() => {
                      setError(null);
                      rpc.call("bind", { instanceKey: i.key, threadId }).then(
                        () => {
                          refetch();
                          onOpenChange(false);
                        },
                        (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
                      );
                    }}
                  >
                    <Icon name="Code" className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-xs">{i.workspaceRoot ?? "?"}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        pid {i.pid}
                        {current ? ", this thread" : i.threadTitle ? `, now ${i.threadTitle}` : ", not bound"}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The banner counterpart of the card row, for panes that show the thread's
 * context above the composer. The live file and line are on the composer's
 * position chip right below it, so this stays a short status.
 */
export function HelixSegment({ threadId }: { threadId: string }) {
  const { data, position } = useThreadHelix(threadId);
  const navigate = useBbNavigate();
  const instance = data?.instance ?? null;
  if (!instance) return null;
  const where = position ? whereLabel(position.path, position.line, position.endLine) : whereLabel(instance.focus?.path, instance.focus?.line, instance.focus?.endLine);
  const connected = instance.status === "connected";
  return (
    <button
      type="button"
      onClick={() => navigate.toPluginPanel(EDITOR_PANEL, { subPath: threadId })}
      title={`${connected ? `Helix is at ${where ?? "no file"}` : `Helix is ${instance.status}`}. Open the editor.`}
      className="inline-flex h-7 items-center gap-1.5 rounded-md px-1.5 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <StatusDot status={connected ? "running" : "failed"} />
      <span className="text-foreground">Helix</span>
      {instance.diagnostics.errors ? <span className="tabular-nums text-destructive">{instance.diagnostics.errors} errors</span> : null}
      {instance.diagnostics.warnings ? <span className="tabular-nums">{instance.diagnostics.warnings} warnings</span> : null}
      {instance.skippedModified.length ? <span className="text-warning-text">{instance.skippedModified.length} not reloaded</span> : null}
    </button>
  );
}

export function useHelixSegmentVisible({ threadId }: { threadId: string }): boolean {
  const banner = useThreadContextKind() === "banner";
  const { data } = useThreadHelix(banner ? threadId : null);
  return banner && Boolean(data?.instance);
}
