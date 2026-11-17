// The comment box over the editor (`:bb-comment` with no text, while the page
// subscribes to `commentPrompt`): the quoted lines, a multi-line field with
// voice input, the severity, Enter to keep it, Cmd+Enter to keep it and send
// every comment not sent yet, Escape to cancel. It sits beside the selection,
// using the cells Helix reports: below it when there is room, above it near
// the bottom edge, and always inside Helix's pane (never over the rail).
// Closing hands the keyboard back to Helix, in the mode it was in.
import { useLayoutEffect, useRef, useState } from "react";
import { experimental_VoiceInputTextarea as VoiceInputTextarea } from "@get-bb/plugin-sdk/app";
import { cn } from "@/lib/utils";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { ShortcutHint } from "../../kit";
import { useHelixRpc } from "../data";
import { addOptimistic, refetchComments } from "../rail/commentsStore";
import { sendComments } from "../review/SendToThread";

export interface CommentRequest {
  path: string;
  languageId: string;
  modified: boolean;
  ranges: { start: { line: number; col: number }; end: { line: number; col: number }; text: string }[];
  screen?: { top: { row: number; col: number }; bottom: { row: number; col: number }; rows: number; cols: number };
}

const SEVERITIES = [
  { value: "note", label: "Note" },
  { value: "suggestion", label: "Suggestion" },
  { value: "issue", label: "Issue" },
  { value: "blocker", label: "Blocker" },
] as const;
type Severity = (typeof SEVERITIES)[number]["value"];

const GAP = 6;
const MARGIN = 8;

/** Lines a Helix selection covers: a selection ending at column 1 of a line ends on the line before. */
export function selectionLines(range: CommentRequest["ranges"][number]): { start: number; end: number } {
  const start = Math.min(range.start.line, range.end.line);
  let end = Math.max(range.start.line, range.end.line);
  const last = range.start.line > range.end.line ? range.start : range.end;
  if (end > start && last.col <= 1) end -= 1;
  return { start, end };
}

/**
 * Where the box goes, in pixels inside the editor pane: beside the
 * selection's cells, below it when the box fits there, else above, clamped
 * to the pane on every side.
 */
export function placeBox(
  request: CommentRequest,
  pane: { width: number; height: number },
  cell: { width: number; height: number },
  box: { width: number; height: number },
): { left: number; top: number; above: boolean } {
  const screen = request.screen;
  const width = Math.min(box.width, pane.width - 2 * MARGIN);
  if (!screen) return { left: Math.max(MARGIN, (pane.width - width) / 2), top: Math.max(MARGIN, (pane.height - box.height) / 2), above: false };
  const left = Math.min(Math.max(MARGIN, screen.top.col * cell.width), Math.max(MARGIN, pane.width - width - MARGIN));
  const below = (screen.bottom.row + 1) * cell.height + GAP;
  const above = screen.top.row * cell.height - GAP - box.height;
  if (below + box.height <= pane.height - MARGIN) return { left, top: below, above: false };
  if (above >= MARGIN) return { left, top: above, above: true };
  // A selection that fills the pane: the box rests on the pane's bottom edge.
  return { left, top: Math.max(MARGIN, pane.height - box.height - MARGIN), above: false };
}

export function CommentBox({
  threadId,
  request,
  pane,
  cell,
  onClose,
}: {
  threadId: string;
  request: CommentRequest;
  pane: { width: number; height: number };
  cell: { width: number; height: number };
  onClose(): void;
}) {
  const rpc = useHelixRpc();
  const scope = usePortalScopeProps() as unknown as Record<string, string>;
  const [body, setBody] = useState("");
  const [severity, setSeverity] = useState<Severity>("note");
  const [voice, setVoice] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 480, height: 200 });
  const range = request.ranges[0];
  const span = range ? selectionLines(range) : { start: 1, end: 1 };
  const quoted = (range?.text ?? "").replace(/\n$/u, "").split("\n");

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setSize((s) => (s.height === el.offsetHeight && s.width === el.offsetWidth ? s : { width: el.offsetWidth, height: el.offsetHeight }));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const place = placeBox(request, pane, cell, { width: Math.min(480, pane.width - 2 * MARGIN), height: size.height });

  const keep = async (sendNow: boolean) => {
    const text = body.trim();
    if (!text || busy || voice || !range) return;
    setBusy(true);
    setError(null);
    try {
      const created = await rpc.call("createComment", {
        threadId,
        path: request.path,
        startLine: span.start,
        endLine: span.end,
        snippet: range.text,
        languageId: request.languageId,
        modified: request.modified,
        body: text,
        severity,
      });
      addOptimistic(threadId, {
        id: created.id,
        path: request.path,
        startLine: span.start,
        endLine: span.end,
        snippet: range.text,
        body: text,
        severity,
        state: "unsent",
        replies: [],
        local: created.kept === "local",
        updatedAt: Date.now(),
      });
      onClose();
      if (sendNow) await sendComments(rpc, threadId, scope);
      else void refetchComments(rpc, threadId);
    } catch (cause) {
      setBusy(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div
      ref={box}
      role="dialog"
      aria-label={`Comment on ${span.start === span.end ? `line ${span.start}` : `lines ${span.start}-${span.end}`}`}
      className={cn(
        "absolute z-20 flex flex-col gap-2 rounded-xl border border-border/60 bg-background p-2.5 shadow-lg",
        "motion-safe:animate-[helix-box-in_200ms_cubic-bezier(0.22,1,0.36,1)]",
        place.above ? "origin-bottom" : "origin-top",
      )}
      style={{ left: place.left, top: place.top, width: Math.min(480, pane.width - 2 * MARGIN) }}
      data-helix-comment-box
      // Keys here are the box's, not Helix's or bb's (Escape would leave the page).
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          void keep(true);
        } else if (event.key === "Enter" && !event.shiftKey && !event.altKey) {
          event.preventDefault();
          void keep(false);
        }
      }}
    >
      <div className="flex items-baseline gap-2 text-xs text-muted-foreground">
        <span className="min-w-0 truncate font-mono" title={request.path}>
          {request.path.split("/").pop()}
        </span>
        <span className="shrink-0 tabular-nums">{span.start === span.end ? `line ${span.start}` : `lines ${span.start}-${span.end}`}</span>
      </div>
      <pre className="max-h-20 overflow-hidden whitespace-pre rounded-md border-l-2 border-border bg-muted/60 px-2 py-1 font-mono text-[11px] leading-4 text-muted-foreground">
        {quoted.slice(0, 4).join("\n")}
        {quoted.length > 4 ? `\n${quoted.length - 4} more lines` : ""}
      </pre>
      <VoiceInputTextarea
        autoFocus
        value={body}
        onValueChange={setBody}
        onVoiceInputActiveChange={setVoice}
        rows={3}
        placeholder="What should change here?"
        aria-label="Comment"
        className="max-h-48 min-h-16 w-full resize-none rounded-md border border-border/60 bg-background px-2 py-1.5 text-sm leading-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <div className="flex flex-wrap items-center gap-1" role="radiogroup" aria-label="Severity">
        {SEVERITIES.map((s) => (
          <button
            key={s.value}
            type="button"
            role="radio"
            aria-checked={severity === s.value}
            onClick={() => setSeverity(s.value)}
            className={cn(
              "h-6 rounded-md px-2 text-xs transition-colors duration-[120ms] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              severity === s.value ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-state-hover",
            )}
          >
            {s.label}
          </button>
        ))}
      </div>
      {error ? (
        <p className="text-xs leading-5 text-destructive" role="status">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 pt-2" {...scope}>
        <ShortcutHint combo="Enter" label="keep" />
        <ShortcutHint combo="mod+Enter" label="keep and send" />
        <ShortcutHint combo="Escape" label="cancel" />
      </div>
    </div>
  );
}
