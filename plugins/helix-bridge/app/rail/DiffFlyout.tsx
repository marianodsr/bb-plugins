// The flyout beside the rail: the selected file's diff, drawn by bb's own diff
// viewer, so a review can be skimmed with j and k without leaving the list.
// While it is open it is the editor area (skimming is a mode: you read diffs,
// not the editor) and it leaves when focus leaves the list. A file's patch is
// fetched once the cursor rests on it, then kept until the file changes.
import { useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { experimental_Diff as Diff } from "@get-bb/plugin-sdk/app";
import type { ChangedFile } from "../../server";
import { cn } from "@/lib/utils";
import { ShortcutHint, Skeleton } from "../../kit";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { useHelixRpc } from "../data";
import { patchFor } from "./changesStore";

/** Wait this long on a row before fetching its diff, so holding j costs nothing. */
const SETTLE_MS = 140;
/** Less room than this beside the rail and the flyout covers the page instead. */
const MIN_ROOM = 360;

interface Place {
  left: number;
  top: number;
  bottom: number;
  width: number;
}

/** New-side lines where each hunk's first change is. */
export function hunkStarts(patch: string): number[] {
  const starts: number[] = [];
  let line = 0;
  let inHunk = false;
  let found = false;
  for (const text of patch.split("\n")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(text);
    if (header) {
      line = Number(header[1]);
      inHunk = true;
      found = false;
      continue;
    }
    if (!inHunk) continue;
    if (text.startsWith("+") || text.startsWith("-")) {
      if (!found) {
        starts.push(Math.max(1, line));
        found = true;
      }
      if (text.startsWith("+")) line += 1;
    } else if (text.startsWith(" ")) {
      line += 1;
      found = false;
    }
  }
  return starts;
}

export function DiffFlyout({ threadId, file, anchor, onOpen }: { threadId: string; file: ChangedFile | null; anchor: React.RefObject<HTMLElement | null>; onOpen(line?: number): void }) {
  const rpc = useHelixRpc();
  const [shown, setShown] = useState<ChangedFile | null>(null);
  const [patch, setPatch] = useState<{ key: string; patch: string | null; message: string | null; truncated: boolean } | null>(null);
  const [place, setPlace] = useState<Place | null>(null);
  const portal = usePortalScopeProps();

  // Settle, then fetch.
  useEffect(() => {
    if (!file) {
      setShown(null);
      return;
    }
    const key = `${file.path}\u0000${file.revision}`;
    const timer = window.setTimeout(() => {
      setShown(file);
      if (!file.revision) {
        setPatch({ key, patch: null, message: "This file has no diff to show", truncated: false });
        return;
      }
      void patchFor(rpc, threadId, file.path, file.revision).then(
        (r) => setPatch({ key, patch: r.patch, message: r.message, truncated: r.truncated }),
        (cause: unknown) => setPatch({ key, patch: null, message: cause instanceof Error ? cause.message : String(cause), truncated: false }),
      );
    }, SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [file, rpc, threadId]);

  // Beside the rail, over the editor.
  useLayoutEffect(() => {
    if (!shown) return;
    const measure = () => {
      const surface = document.querySelector<HTMLElement>("[data-helix-surface]")?.getBoundingClientRect();
      const rail = anchor.current?.getBoundingClientRect();
      if (!surface) return setPlace(null);
      // Skimming is a mode: the flyout takes the whole editor area, right of
      // the rail (bb's sidebar ends where the page starts; the sheet lies over
      // the page). Beside a sheet on a compact window it covers the sheet too.
      let left = rail && rail.right > surface.left ? Math.round(rail.right) : surface.left;
      let top = surface.top;
      if (surface.right - left < MIN_ROOM) {
        left = surface.left;
        if (rail) top = Math.min(top, Math.round(rail.top));
      }
      const width = surface.right - left;
      setPlace({ left, top, bottom: Math.max(0, window.innerHeight - surface.bottom), width });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [shown, anchor]);

  if (!shown || !place) return null;
  const key = `${shown.path}\u0000${shown.revision}`;
  const ready = patch?.key === key ? patch : null;
  const starts = ready?.patch ? hunkStarts(ready.patch) : [];
  return createPortal(
    <aside
      {...portal}
      className="fixed z-40 flex flex-col overflow-hidden bg-background motion-safe:animate-[helix-flyout-in_200ms_cubic-bezier(0.22,1,0.36,1)]"
      style={{ left: place.left, top: place.top, bottom: place.bottom, width: place.width }}
      aria-label={`Diff of ${shown.path}`}
      // Clicks here keep the list's focus (and the flyout); wheel scrolling needs none.
      onMouseDown={(event) => {
        if (!(event.target as HTMLElement).closest("button")) event.preventDefault();
      }}
      data-helix-flyout
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2">
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={shown.path}>
          {shown.path}
        </span>
        <span className="shrink-0 text-xs tabular-nums">
          <span className="text-diff-added">+{shown.additions}</span> <span className="text-diff-removed">-{shown.deletions}</span>
        </span>
        {shown.status === "deleted" ? (
          <span className="shrink-0 text-xs text-muted-foreground">Deleted in this review</span>
        ) : (
          <button
            type="button"
            onClick={() => onOpen()}
            className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Open in Helix <ShortcutHint combo="Enter" />
          </button>
        )}
      </header>
      {starts.length > 1 && shown.status !== "deleted" ? (
        <nav className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border/60 px-3 py-1.5" aria-label="Changes in this file">
          <span className="mr-1 text-xs text-muted-foreground">{starts.length} changes</span>
          {starts.slice(0, 12).map((line) => (
            <button
              key={line}
              type="button"
              onClick={() => onOpen(line)}
              title={`Open in Helix at line ${line}`}
              className="h-6 rounded-md px-1.5 font-mono text-xs tabular-nums text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {line}
            </button>
          ))}
          {starts.length > 12 ? <span className="text-xs text-muted-foreground">and {starts.length - 12} more</span> : null}
        </nav>
      ) : null}
      <div className={cn("min-h-0 flex-1 overflow-auto")}>
        {!ready ? (
          <div className="flex flex-col gap-2 p-3">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className={cn("h-3.5", i % 3 === 0 ? "w-3/5" : i % 3 === 1 ? "w-4/5" : "w-2/5")} />
            ))}
          </div>
        ) : ready.patch ? (
          <>
            <Diff patch={ready.patch} path={shown.path} view="unified" overflow="scroll" />
            {ready.truncated ? <p className="px-3 py-2 text-xs text-muted-foreground">The diff is cut short here; open the file in Helix for the rest.</p> : null}
          </>
        ) : (
          <p className="p-3 text-xs leading-5 text-muted-foreground">{ready.message ?? "No diff to show"}</p>
        )}
      </div>
    </aside>,
    document.body,
  );
}
