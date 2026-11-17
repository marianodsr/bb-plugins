// The editor page's rail, drawn in bb's own sidebar while the page is open
// (navPanel `experimental_sidebar`), so the page body is all Helix. At the top
// the thread and a way to other threads' editors; then three tabs: Files (the
// yazi tree), Changes (the review) and Comments. bb gives it resizing and
// collapse; Escape inside it goes back to Helix, not out of the page.
import { useEffect, useMemo, useRef, useState } from "react";
import { useBbNavigate, useRealtime, useSettings } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { ShortcutSheet, ThreadChip, useHotkeys } from "../../kit";
import { useGhostty, useInstances } from "../data";
import { EDITOR_PANEL, threadFromSubPath } from "../pages/EditorPage";
import { TreePane, type TreeHandle } from "../surface/TreePane";
import { ChangesTab } from "./ChangesTab";
import { useChanges } from "./changesStore";
import { CommentsTab } from "./CommentsTab";
import { useComments } from "./commentsStore";
import { editorFocus, pendingTreeReveal, railFocus, railHasFocus, railSheet, railShown, railTab, sidebarRailVisible, useRailSheet, useRailTab, type RailTab } from "./railStore";

/** The rail in bb's sidebar. Collapsed or a closed drawer, it draws nothing and the page offers it as a sheet. */
export function EditorRail({ subPath }: { subPath: string }) {
  const threadId = threadFromSubPath(subPath);
  const probe = useRef<HTMLDivElement>(null);
  const [onScreen, setOnScreen] = useState(true);
  const [height, setHeight] = useState<number | null>(null);
  const sheet = useRailSheet();
  // bb's sidebar slot is a padded block in a scrolling column: the rail fills
  // what the column shows, so the tree and the list get the whole height.
  useEffect(() => {
    const el = probe.current;
    if (!el) return;
    let column: HTMLElement | null = el.parentElement;
    while (column && !/(auto|scroll)/u.test(getComputedStyle(column).overflowY)) column = column.parentElement;
    if (!column) return;
    const measure = () => {
      const top = el.getBoundingClientRect().top - column!.getBoundingClientRect().top + column!.scrollTop;
      let bottom = 0;
      for (let p = el.parentElement; p && p !== column; p = p.parentElement) bottom += parseFloat(getComputedStyle(p).paddingBottom) || 0;
      setHeight(Math.max(240, Math.floor(column!.clientHeight - top - bottom)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(column);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const el = probe.current;
    if (!el || !threadId) return;
    const observer = new IntersectionObserver(([entry]) => {
      const visible = Boolean(entry?.isIntersecting);
      setOnScreen(visible);
      if (visible && !el.closest("[inert]")) railShown.set(threadId);
      else if (railShown.get() === threadId) railShown.set(null);
      if (visible && !el.closest("[inert]") && railSheet.get() === threadId) railSheet.set(null);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      if (railShown.get() === threadId) railShown.set(null);
    };
  }, [threadId]);
  if (!threadId) return null;
  return (
    <div ref={probe} className="flex min-h-0 flex-col" style={{ height: height ?? "100%" }} data-helix-sidebar-rail={threadId}>
      {onScreen && sheet !== threadId ? <Rail key={threadId} threadId={threadId} /> : null}
    </div>
  );
}

export function Rail({ threadId, onLeave }: { threadId: string; onLeave?(): void }) {
  const tab = useRailTab();
  const root = useRef<HTMLDivElement>(null);
  const treeHandle = useRef<TreeHandle | null>(null);
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
        // bb's sidebar treats Escape as "Back to app"; in the rail it means back to Helix.
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
      <ShortcutSheet trigger={false} />
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

function FilesTab({ threadId, handle, onLeave }: { threadId: string; handle: { current: TreeHandle | null }; onLeave?(): void }) {
  const ghostty = useGhostty();
  const { values } = useSettings();
  const treeStaysOpen = values?.treeStaysOpen === true;
  // yazi quit (q): start it again, back in Helix.
  const [generation, setGeneration] = useState(0);

  // :bb-files: show the tree on that file and give it the keyboard.
  useRealtime("files", (payload: unknown) => {
    const request = payload as { threadId?: string; path?: string | null } | null;
    if (request?.threadId !== threadId) return;
    // A rail in bb's closed drawer cannot take the keyboard: the page opens the sheet.
    if (!sidebarRailVisible(threadId) && railSheet.get() !== threadId) return;
    if (railTab.get() !== "files") railTab.set("files");
    if (handle.current) {
      if (request.path) handle.current.reveal(request.path);
      handle.current.focus();
    } else pendingTreeReveal.set({ threadId, path: request.path ?? null, focus: true, at: Date.now() });
  });

  if (!ghostty.data) return null;
  return (
    <div className={cn("flex min-h-0 flex-1")}>
      <TreePane
        key={generation}
        threadId={threadId}
        width={0}
        fill
        config={ghostty.data}
        handle={handle}
        onQuit={() => {
          onLeave?.();
          editorFocus.get(threadId)?.();
          setGeneration((n) => n + 1);
        }}
        onEscape={() => {
          onLeave?.();
          editorFocus.get(threadId)?.();
        }}
        // A file chosen here: Helix takes the keyboard, unless the owner keeps the tree.
        onOpened={() => {
          if (treeStaysOpen) return;
          onLeave?.();
          editorFocus.get(threadId)?.();
        }}
        onReady={() => {
          const pending = pendingTreeReveal.get();
          if (pending?.threadId === threadId) {
            pendingTreeReveal.set(null);
            if (pending.path) handle.current?.reveal(pending.path);
            if (pending.focus) handle.current?.focus();
          }
        }}
      />
    </div>
  );
}
