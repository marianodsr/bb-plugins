// The rail's Changes tab: what is being reviewed and how much is left. Open
// it and you are reviewing: the first visit starts a review in Helix (the
// branch when it has commits of its own, else the uncommitted changes).
// Files come from the review the server keeps (bb's Git plugin, refreshed on
// signals only), viewed marks are bb's own, and moving through the list
// shows each file's diff in a flyout beside the rail.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChangedFile } from "../../server";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { EmptyState, ProgressLine, Segmented, ShortcutHint, SkeletonRows, useHotkeys } from "../../kit";
import { useHelixRpc } from "../data";
import { setViewedOptimistic, useChanges, type ChangesData } from "./changesStore";
import { DiffFlyout } from "./DiffFlyout";
import { editorFocus } from "./railStore";

type Scope = "uncommitted" | "branch" | "pr" | "commit";
type Row = { kind: "dir"; dir: string; files: number; unviewed: number; collapsed: boolean } | { kind: "file"; file: ChangedFile; dir: string };

const ROW = 28;
/** Past this many files, folders start collapsed. */
const COLLAPSE_OVER = 300;
const STATUS: Record<ChangedFile["status"], { letter: string; className: string; label: string }> = {
  added: { letter: "A", className: "text-diff-added", label: "Added" },
  modified: { letter: "M", className: "text-muted-foreground", label: "Modified" },
  deleted: { letter: "D", className: "text-diff-removed", label: "Deleted" },
  renamed: { letter: "R", className: "text-muted-foreground", label: "Renamed" },
};

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}
function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function ChangesTab({ threadId, active, root, onLeave }: { threadId: string; active: boolean; root: React.RefObject<HTMLDivElement | null>; onLeave?(): void }) {
  const rpc = useHelixRpc();
  const { data, error, loading, refetch } = useChanges(threadId);
  const [pendingScope, setPendingScope] = useState<Scope | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const autoStarted = useRef(false);
  const review = data?.review ?? null;

  const start = (target: string, scope: Scope | null) => {
    setPendingScope(scope);
    setStartError(null);
    rpc.call("startReview", { threadId, target }).then(
      () => {
        setPendingScope(null);
        refetch();
      },
      (cause: unknown) => {
        setPendingScope(null);
        setStartError(cause instanceof Error ? cause.message : String(cause));
        refetch();
      },
    );
  };

  // Opening the tab is starting the review.
  useEffect(() => {
    if (!active || !data || autoStarted.current) return;
    if (data.capable && data.connected && !data.review && !data.error) {
      autoStarted.current = true;
      start("auto", null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, data]);

  if (!data) return loading ? <SkeletonRows count={8} dense /> : <EmptyState icon="AlertCircle" tone="error" title="The changes could not be read" description={error ?? "Try again in a moment."} />;
  if (!data.connected) return <EmptyState icon="Code" title="Helix is starting" description="The changes show here once the editor is up." />;
  if (!data.capable) return <EmptyState icon="GitCompare" title="This Helix cannot review" description="Update the Helix Bridge build (bb hx doctor says how), then open this tab again." />;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-helix-changes>
      <ScopeBar threadId={threadId} data={data} pending={pendingScope} onPick={start} />
      <ProgressLine active={pendingScope !== null || (loading && Boolean(review))} />
      {startError ?? data.error ? (
        <p className="mx-2 mb-2 rounded-md bg-muted px-2 py-1.5 text-xs leading-5 text-muted-foreground" role="status">
          {startError ?? data.error}
        </p>
      ) : null}
      {review ? <FileList threadId={threadId} review={review} root={root} onLeave={onLeave} /> : pendingScope || !autoStarted.current ? <SkeletonRows count={6} dense /> : null}
    </div>
  );
}

function ScopeBar({ threadId, data, pending, onPick }: { threadId: string; data: ChangesData; pending: Scope | null; onPick(target: string, scope: Scope): void }) {
  const rpc = useHelixRpc();
  const review = data.review;
  const current = pending ?? review?.scope ?? null;
  const [commits, setCommits] = useState<{ sha: string; subject: string; when: string }[] | null>(null);
  const [picking, setPicking] = useState(false);
  const options: { value: Scope; label: string; title: string }[] = [
    { value: "uncommitted", label: "Uncommitted", title: "The working tree against HEAD" },
    { value: "branch", label: "Branch", title: "Everything since this branch left its base" },
    ...(data.hasPullRequest ? [{ value: "pr" as const, label: "PR", title: "Against the pull request's base" }] : []),
    { value: "commit", label: "Commit", title: "One commit against its parent" },
  ];
  const pick = (scope: Scope) => {
    if (scope === "commit") {
      setPicking(true);
      if (!commits) void rpc.call("recentCommits", { threadId }).then((r) => setCommits(r.commits), () => setCommits([]));
      return;
    }
    setPicking(false);
    onPick(scope, scope);
  };
  return (
    <div className="flex shrink-0 flex-col gap-1.5 px-2 pb-2">
      <Segmented aria-label="What to review" value={(picking ? "commit" : current) ?? "uncommitted"} onChange={pick} options={options} className="w-full" />
      {picking ? (
        <ul className="max-h-56 overflow-y-auto rounded-lg border border-border/60 bg-card py-1" aria-label="Recent commits" data-helix-commits>
          {commits === null ? (
            <li className="px-2 py-1 text-xs text-muted-foreground">Reading the last commits</li>
          ) : commits.length === 0 ? (
            <li className="px-2 py-1 text-xs text-muted-foreground">No commits found</li>
          ) : (
            commits.map((c) => (
              <li key={c.sha}>
                <button
                  type="button"
                  className="flex h-7 w-full items-center gap-2 px-2 text-left text-xs hover:bg-state-hover focus-visible:bg-state-hover focus-visible:outline-none"
                  onClick={() => {
                    setPicking(false);
                    onPick(`commit ${c.sha}`, "commit");
                  }}
                >
                  <span className="shrink-0 font-mono tabular-nums text-muted-foreground">{c.sha.slice(0, 7)}</span>
                  <span className="min-w-0 flex-1 truncate">{c.subject}</span>
                  <span className="shrink-0 text-muted-foreground">{c.when.replace(/ ago$/u, "")}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      ) : review ? (
        <div className="flex min-w-0 items-baseline gap-2 px-0.5 text-xs">
          <span className="min-w-0 flex-1 truncate text-muted-foreground" title={review.title}>
            {review.title}
          </span>
          <span className="shrink-0 tabular-nums">
            <span className="text-diff-added">+{review.additions}</span> <span className="text-diff-removed">-{review.deletions}</span>
          </span>
        </div>
      ) : null}
    </div>
  );
}

function FileList({ threadId, review, root, onLeave }: { threadId: string; review: NonNullable<ChangesData["review"]>; root: React.RefObject<HTMLDivElement | null>; onLeave?(): void }) {
  const rpc = useHelixRpc();
  const [unviewedOnly, setUnviewedOnly] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string> | null>(null);
  const [cursor, setCursor] = useState(0);
  const [listFocused, setListFocused] = useState(false);
  const [flashing, setFlashing] = useState<ReadonlySet<string>>(new Set());
  const list = useRef<HTMLDivElement>(null);
  const revisions = useRef<Map<string, string | null> | null>(null);

  const files = review.files;
  const viewed = files.filter((f) => f.viewed).length;

  // Files the agent (or anyone) just changed flash once.
  useEffect(() => {
    const previous = revisions.current;
    const next = new Map(files.map((f) => [f.path, f.revision]));
    revisions.current = next;
    if (!previous) return;
    const changed = files.filter((f) => previous.has(f.path) ? previous.get(f.path) !== f.revision : true).map((f) => f.path);
    if (changed.length === 0 || changed.length > 50) return;
    setFlashing(new Set(changed));
    const timer = window.setTimeout(() => setFlashing(new Set()), 60);
    return () => window.clearTimeout(timer);
  }, [files]);

  const groups = useMemo(() => {
    const byDir = new Map<string, ChangedFile[]>();
    for (const f of files) {
      if (unviewedOnly && f.viewed) continue;
      const dir = dirOf(f.path);
      const list = byDir.get(dir);
      if (list) list.push(f);
      else byDir.set(dir, [f]);
    }
    return [...byDir.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [files, unviewedOnly]);

  const collapsedSet = useMemo(() => collapsed ?? new Set(files.length > COLLAPSE_OVER ? groups.map(([dir]) => dir) : []), [collapsed, files.length, groups]);

  const rows = useMemo(() => {
    const out: Row[] = [];
    // Files at the root come first, without a folder row.
    for (const [dir, list] of groups) {
      const isCollapsed = dir !== "" && collapsedSet.has(dir);
      if (dir !== "") out.push({ kind: "dir", dir, files: list.length, unviewed: list.filter((f) => !f.viewed).length, collapsed: isCollapsed });
      if (!isCollapsed) for (const file of list.sort((a, b) => a.path.localeCompare(b.path))) out.push({ kind: "file", file, dir });
    }
    return out;
  }, [groups, collapsedSet]);

  const at = Math.min(cursor, Math.max(0, rows.length - 1));
  const current = rows[at] ?? null;
  const currentFile = current?.kind === "file" ? current.file : null;

  const toggleDir = (dir: string, open?: boolean) => {
    const next = new Set(collapsedSet);
    const willOpen = open ?? next.has(dir);
    if (willOpen) next.delete(dir);
    else next.add(dir);
    setCollapsed(next);
  };
  // j and k stop on files (and on folders that are closed, whose files are hidden).
  const stop = (row: Row | undefined) => Boolean(row && (row.kind === "file" || row.collapsed));
  const move = (delta: number) =>
    setCursor((c) => {
      let i = Math.min(c, rows.length - 1);
      do i += delta;
      while (i >= 0 && i < rows.length && !stop(rows[i]));
      return i >= 0 && i < rows.length ? i : Math.min(c, rows.length - 1);
    });
  // The cursor starts on the first file, not on a folder.
  useEffect(() => {
    if (current && !stop(current)) {
      const first = rows.findIndex(stop);
      if (first >= 0) setCursor(first);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);
  const open = (file: ChangedFile) => {
    // A deleted file has nothing on disk to open: its old text is the flyout's diff.
    if (file.status === "deleted") return;
    void rpc.call("openChange", { threadId, path: file.path }).catch(() => {});
    setListFocused(false);
    onLeave?.();
    editorFocus.get(threadId)?.();
  };
  const markAndNext = () => {
    if (!currentFile) return;
    void setViewedOptimistic(rpc, threadId, currentFile.path, !currentFile.viewed);
    if (!currentFile.viewed) {
      // On to the next file not yet viewed.
      const next = rows.findIndex((r, i) => i > at && r.kind === "file" && !r.file.viewed);
      if (next >= 0) setCursor(next);
    }
  };

  useHotkeys(
    [
      { key: ["j", "ArrowDown"], handler: () => move(1), description: "Next file", group: "Changes" },
      { key: ["k", "ArrowUp"], handler: () => move(-1), description: "Previous file", group: "Changes" },
      {
        key: "Enter",
        handler: () => {
          if (current?.kind === "dir") toggleDir(current.dir);
          else if (currentFile) open(currentFile);
        },
        description: "Open in Helix at the first change",
        group: "Changes",
      },
      { key: "v", handler: markAndNext, description: "Mark viewed and go to the next", group: "Changes" },
      { key: "u", handler: () => setUnviewedOnly((u) => !u), description: "Show only files not viewed", group: "Changes" },
      { key: ["l", "ArrowRight"], handler: () => current?.kind === "dir" && toggleDir(current.dir, true), description: "Open a folder", group: "Changes" },
      {
        key: ["h", "ArrowLeft"],
        handler: () => {
          if (current?.kind === "dir") toggleDir(current.dir, false);
          else if (current) setCursor(Math.max(0, rows.findIndex((r) => r.kind === "dir" && r.dir === current.dir)));
        },
        description: "Close a folder",
        group: "Changes",
      },
    ],
    { scope: list },
  );

  // Keep the cursor row in view.
  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    const top = at * ROW;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW - el.clientHeight;
  }, [at]);

  if (files.length === 0)
    return <EmptyState icon="Check" title="No changes yet" description={`${review.title}: nothing to review. New changes appear here as they happen.`} />;

  return (
    <>
      <div className="flex shrink-0 items-center gap-2 px-2.5 pb-1.5 text-xs">
        <span className="tabular-nums text-muted-foreground" data-helix-viewed-count>
          {viewed === files.length ? "All viewed" : `${viewed} of ${files.length} viewed`}
        </span>
        <span className="h-0.5 min-w-6 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden>
          <span className="block h-full origin-left rounded-full bg-foreground/50 transition-transform duration-200 ease-out" style={{ transform: `scaleX(${files.length ? viewed / files.length : 0})` }} />
        </span>
        <button
          type="button"
          onClick={() => setUnviewedOnly((u) => !u)}
          aria-pressed={unviewedOnly}
          title="Show only files not viewed (U)"
          className={cn("h-6 shrink-0 rounded-md px-1.5 transition-colors duration-[120ms] hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", unviewedOnly ? "bg-muted text-foreground" : "text-muted-foreground")}
        >
          Unviewed
        </button>
      </div>
      <VirtualRows
        listRef={list}
        rows={rows}
        cursor={at}
        flashing={flashing}
        onFocusChange={setListFocused}
        onPick={(i) => setCursor(i)}
        onOpen={(row) => (row.kind === "dir" ? toggleDir(row.dir) : open(row.file))}
        onToggleViewed={(file) => void setViewedOptimistic(rpc, threadId, file.path, !file.viewed)}
      />
      {unviewedOnly && rows.length === 0 ? <p className="px-3 py-2 text-xs text-muted-foreground">Every file is viewed. Press U to show them all.</p> : null}
      {review.truncated ? <p className="shrink-0 px-3 py-1.5 text-xs text-muted-foreground">bb's Git plugin listed the first {files.length} files. Review a narrower scope to see the rest.</p> : null}
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 px-2.5 py-1.5">
        <ShortcutHint combo="Enter" label="open" />
        <ShortcutHint combo="v" label="viewed" />
        <ShortcutHint combo="?" label="keys" />
      </div>
      <DiffFlyout
        threadId={threadId}
        file={listFocused ? currentFile : null}
        anchor={root}
        onOpen={(line) => {
          if (!currentFile) return;
          void rpc.call("openChange", { threadId, path: currentFile.path, line }).catch(() => {});
          setListFocused(false);
          onLeave?.();
          editorFocus.get(threadId)?.();
        }}
      />
    </>
  );
}

function VirtualRows({
  listRef,
  rows,
  cursor,
  flashing,
  onFocusChange,
  onPick,
  onOpen,
  onToggleViewed,
}: {
  listRef: React.RefObject<HTMLDivElement | null>;
  rows: Row[];
  cursor: number;
  flashing: ReadonlySet<string>;
  onFocusChange(focused: boolean): void;
  onPick(index: number): void;
  onOpen(row: Row): void;
  onToggleViewed(file: ChangedFile): void;
}) {
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(400);
  const frame = useRef(0);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    setHeight(el.clientHeight);
    const observer = new ResizeObserver(() => setHeight(el.clientHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, [listRef]);
  const first = Math.max(0, Math.floor(scroll / ROW) - 8);
  const last = Math.min(rows.length, Math.ceil((scroll + height) / ROW) + 8);
  return (
    <div
      ref={listRef}
      tabIndex={0}
      role="listbox"
      aria-label="Changed files"
      aria-activedescendant={rows[cursor] ? `helix-change-${cursor}` : undefined}
      data-rail-focus
      onFocus={() => onFocusChange(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onFocusChange(false);
      }}
      onScroll={(event) => {
        const top = event.currentTarget.scrollTop;
        cancelAnimationFrame(frame.current);
        frame.current = requestAnimationFrame(() => setScroll(top));
      }}
      className="relative min-h-0 flex-1 overflow-y-auto focus-visible:outline-none"
      data-helix-change-list
    >
      <div style={{ height: rows.length * ROW }} className="relative">
        {rows.slice(first, last).map((row, offset) => {
          const index = first + offset;
          const selected = index === cursor;
          const style = { transform: `translateY(${index * ROW}px)` };
          if (row.kind === "dir")
            return (
              <div
                key={`d:${row.dir}`}
                id={`helix-change-${index}`}
                role="option"
                aria-selected={selected}
                aria-expanded={!row.collapsed}
                style={style}
                onMouseDown={() => onPick(index)}
                onDoubleClick={() => onOpen(row)}
                onClick={() => onOpen(row)}
                className={cn("absolute inset-x-1 top-0 flex h-7 cursor-default items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground", selected && "bg-state-hover text-foreground")}
              >
                <Icon name={row.collapsed ? "ChevronRight" : "ChevronDown"} className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate font-mono" title={row.dir || "(root)"}>
                  {row.dir || "(root)"}
                </span>
                <span className="shrink-0 tabular-nums">{row.unviewed > 0 ? row.unviewed : <Icon name="Check" className="size-3" />}</span>
              </div>
            );
          const f = row.file;
          const status = STATUS[f.status];
          return (
            <div
              key={`f:${f.path}`}
              id={`helix-change-${index}`}
              role="option"
              aria-selected={selected}
              style={style}
              onMouseDown={() => onPick(index)}
              onDoubleClick={() => onOpen(row)}
              title={`${status.label}: ${f.path}${f.previousPath ? ` (from ${f.previousPath})` : ""}`}
              className={cn(
                "absolute inset-x-1 top-0 flex h-7 cursor-default items-center gap-1.5 rounded-md pr-1.5 text-xs transition-colors duration-700 ease-out",
                row.dir === "" ? "pl-1.5" : "pl-5",
                selected ? "bg-state-hover" : flashing.has(f.path) ? "bg-primary/15 duration-0" : "",
              )}
              data-helix-change={f.path}
            >
              <button
                type="button"
                tabIndex={-1}
                aria-label={f.viewed ? `Mark ${f.path} not viewed` : `Mark ${f.path} viewed`}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  onToggleViewed(f);
                }}
                className={cn("flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors duration-[120ms]", f.viewed ? "border-transparent bg-muted text-muted-foreground" : "border-border hover:border-foreground/60")}
              >
                {f.viewed ? <Icon name="Check" className="size-3" /> : null}
              </button>
              <span className={cn("w-3 shrink-0 text-center font-mono text-[11px]", status.className)} aria-hidden>
                {status.letter}
              </span>
              <span className={cn("min-w-0 flex-1 truncate font-mono", f.viewed && "text-muted-foreground")}>{nameOf(f.path)}</span>
              <span className="shrink-0 tabular-nums text-[11px]">
                {f.binary ? (
                  <span className="text-muted-foreground">binary</span>
                ) : (
                  <>
                    {f.additions > 0 ? <span className="text-diff-added">+{f.additions}</span> : null}
                    {f.additions > 0 && f.deletions > 0 ? " " : null}
                    {f.deletions > 0 ? <span className="text-diff-removed">-{f.deletions}</span> : null}
                  </>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
