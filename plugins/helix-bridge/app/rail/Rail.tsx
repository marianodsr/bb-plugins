// The editor page's rail: a sheet over the editor's left edge, there only
// while it is used (EditorPage's RailSheet). At the top the thread and a way
// to other threads' editors; then three tabs: Files (the yazi tree), Changes
// (the review) and Comments. Choosing something, or Escape, closes it and
// Helix has the keyboard again.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useBbNavigate, useRealtime, useSettings } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { ShortcutSheet, ThreadChip, useHotkeys } from "../../kit";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { useHelixRpc, useInstances } from "../data";
import { FileTree, type FileTreeHandle } from "../files/FileTree";
import { useRpcFiles } from "../files/rpcSource";
import { useBbThreadLink } from "../files/threadLink";
import { HELIX_KEYS } from "../keys";
import { sendComments } from "../review/SendToThread";
import { EDITOR_PANEL, threadFromSubPath } from "../pages/EditorPage";
import { ChangesTab } from "./ChangesTab";
import { useChanges } from "./changesStore";
import { CommentsTab } from "./CommentsTab";
import { useComments } from "./commentsStore";
import { editorFocus, pendingTreeReveal, railFocus, railHasFocus, railTab, useRailTab, type RailTab } from "./railStore";

export function Rail({ threadId, onLeave }: { threadId: string; onLeave?(): void }) {
  const tab = useRailTab();
  const root = useRef<HTMLDivElement>(null);
  const treeHandle = useRef<FileTreeHandle | null>(null);
  const { data } = useChanges(threadId);
  const files = data?.review?.files;
  const unviewed = useMemo(() => files?.filter((f) => !f.viewed).length ?? 0, [files]);
  const comments = useComments(threadId).data;
  // What needs the owner (the agent answered or resolved), else what waits to be sent.
  const commentCount = comments ? comments.needsYou || comments.unsent : 0;

  useEffect(() => {
    const focus = () => {
      if (root.current && root.current.getBoundingClientRect().right <= 0) return false;
      if (railTab.get() === "files" && treeHandle.current) {
        treeHandle.current.focus();
        return true;
      }
      const target = root.current?.querySelector<HTMLElement>("[data-rail-focus]");
      target?.focus();
      return Boolean(target);
    };
    const has = () => Boolean(root.current?.contains(document.activeElement));
    railFocus.set(threadId, focus);
    railHasFocus.set(threadId, has);
    return () => {
      if (railFocus.get(threadId) === focus) railFocus.delete(threadId);
      if (railHasFocus.get(threadId) === has) railHasFocus.delete(threadId);
    };
  }, [threadId]);

  // :bb-files while the rail is showing (closed, the page opens it on Files):
  // the tree on that file, with the keyboard.
  useRealtime("files", (payload: unknown) => {
    const request = payload as { threadId?: string; path?: string | null } | null;
    if (request?.threadId !== threadId) return;
    railTab.set("files");
    pendingTreeReveal.set({ threadId, path: request.path ?? null, focus: true, at: Date.now() });
  });

  const rpc = useHelixRpc();
  const scope = usePortalScopeProps() as unknown as Record<string, string>;
  const show = (next: RailTab) => {
    railTab.set(next);
    // The new tab takes the keyboard once it is drawn.
    window.setTimeout(() => railFocus.get(threadId)?.(), 0);
  };
  useHotkeys(
    [
      { key: "1", handler: () => show("files"), description: "Files", group: "Rail" },
      { key: "2", handler: () => show("changes"), description: "Changes", group: "Rail" },
      { key: "3", handler: () => show("comments"), description: "Comments", group: "Rail" },
      { key: "shift+c", handler: () => void sendComments(rpc, threadId, scope), description: "Send to thread", group: "Rail" },
    ],
    { scope: root },
  );

  const options = [
    { value: "files" as const, label: "Files", title: "Files (1)" },
    {
      value: "changes" as const,
      label: (
        <span className="inline-flex items-center gap-1">
          Changes
          {unviewed > 0 ? <span className="tabular-nums text-muted-foreground">{unviewed}</span> : null}
        </span>
      ),
      ariaLabel: unviewed > 0 ? `Changes, ${unviewed} not viewed` : "Changes",
      title: "Changes (2)",
    },
    {
      value: "comments" as const,
      label: (
        <span className="inline-flex items-center gap-1">
          Comments
          {commentCount > 0 ? <span className={cn("tabular-nums", comments?.needsYou ? "text-foreground" : "text-muted-foreground")}>{commentCount}</span> : null}
        </span>
      ),
      ariaLabel: comments?.needsYou ? `Comments, ${comments.needsYou} need you` : commentCount ? `Comments, ${commentCount} not sent` : "Comments",
      title: "Comments (3)",
    },
  ];

  return (
    <div
      ref={root}
      className="flex h-full min-h-0 flex-1 flex-col"
      data-helix-rail={threadId}
      onKeyDown={(event) => {
        // Escape in the rail: it closes and Helix has the keyboard.
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          event.stopPropagation();
          onLeave?.();
          editorFocus.get(threadId)?.();
        }
      }}
    >
      <RailHeader threadId={threadId} />
      <RailTabs value={tab} onChange={show} options={options} />
      <div className={cn("relative flex min-h-0 flex-1 flex-col", tab !== "files" && "pt-2")}>
        {tab === "files" ? <FilesTab threadId={threadId} handle={treeHandle} onLeave={onLeave} /> : null}
        {tab === "changes" ? <ChangesTab threadId={threadId} active root={root} onLeave={onLeave} /> : null}
        {tab === "comments" ? <CommentsTab threadId={threadId} onLeave={onLeave} /> : null}
      </div>
      <ShortcutSheet trigger={false} extra={HELIX_KEYS} />
    </div>
  );
}

/** The rail's tabs: a quiet row, so the Changes tab's own scope control reads as the stronger choice below it. */
function RailTabs({ value, onChange, options }: { value: RailTab; onChange(next: RailTab): void; options: { value: RailTab; label: React.ReactNode; ariaLabel?: string; title: string }[] }) {
  return (
    <div role="tablist" aria-label="Rail" className="flex shrink-0 items-end gap-3 border-b border-border/60 px-3">
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-label={o.ariaLabel}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={cn(
              "relative -mb-px h-8 border-b-2 text-xs transition-colors duration-[120ms] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              selected ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
            data-rail-tab={o.value}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** The thread this editor serves, and the other threads that have one. */
function RailHeader({ threadId }: { threadId: string }) {
  const { data } = useInstances();
  const navigate = useBbNavigate();
  const [open, setOpen] = useState(false);
  const others = useMemo(() => {
    const seen = new Set<string>([threadId]);
    return (data?.instances ?? []).filter((i) => i.threadId && i.status === "connected" && !seen.has(i.threadId) && seen.add(i.threadId));
  }, [data, threadId]);
  return (
    <div className="flex shrink-0 flex-col gap-1 px-2 pb-2 pt-1">
      <div className="flex min-w-0 items-center gap-1">
        <div className="min-w-0 flex-1">
          <ThreadChip threadId={threadId} />
        </div>
        {others.length > 0 ? (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-label={`Other editors (${others.length})`}
            title="Other threads' editors"
            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground transition-colors duration-[120ms] hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Icon name="ArrowLeftRight" className="size-3.5" />
            <span className="tabular-nums">{others.length}</span>
          </button>
        ) : null}
      </div>
      {open ? (
        <ul className="flex flex-col" aria-label="Other threads' editors">
          {others.map((i) => (
            <li key={i.key}>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  navigate.toPluginPanel(EDITOR_PANEL, { subPath: i.threadId! });
                }}
                className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-xs hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Icon name="Code" className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{i.threadTitle ?? i.threadId}</span>
                <span className="shrink-0 truncate font-mono text-muted-foreground">{i.focus?.path?.split("/").pop() ?? ""}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** The Files tab: the workspace's tree (app/files), read through the plugin's RPC, with the thread beside it. */
export function FilesTab({ threadId, handle, onLeave }: { threadId: string; handle: { current: FileTreeHandle | null }; onLeave?(): void }) {
  const { values } = useSettings();
  const { source, server, root } = useRpcFiles(threadId);
  const link = useBbThreadLink(threadId, server);
  const changes = useChanges(threadId).data?.review?.files ?? null;
  const comments = useComments(threadId).data?.comments ?? null;
  // `:bb-files` (space e): the tree on Helix's file. Helix names it by its
  // full path; the tree knows the workspace's once it has listed it.
  const pending = useSyncExternalStore(pendingTreeReveal.subscribe, pendingTreeReveal.get);
  useEffect(() => {
    if (pending?.threadId !== threadId || !handle.current) return;
    const path = pending.path === null ? null : workspacePath(pending.path, root);
    // A full path and no root yet: the first listing is on its way.
    if (path === undefined) return;
    pendingTreeReveal.set(null);
    if (path) handle.current.reveal(path);
    if (pending.focus) handle.current.focus();
  }, [pending, root, threadId, handle]);
  return (
    <FileTree source={source} threadId={threadId} onLeave={onLeave} link={link} changes={changes} comments={comments} staysOpen={values?.treeStaysOpen === true} root={root} handle={handle} />
  );
}

/**
 * A path as the tree names it (relative to the workspace). Null: it is not in
 * the workspace. Undefined: it is a full path and the workspace's is not known yet.
 */
export function workspacePath(path: string, root: string | null): string | null | undefined {
  if (!path.startsWith("/")) return path;
  if (!root) return undefined;
  const base = root.replace(/\/+$/u, "");
  return path === base ? "" : path.startsWith(`${base}/`) ? path.slice(base.length + 1) : null;
}
