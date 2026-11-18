// Send to thread: the comments not sent yet go to the agent beside the
// editor, with the suite's one orchestrated moment (kit/handoff/flight): the
// unsent comments lift and gather at this control, the packet travels to the
// chat's composer (or, with the chat closed, to the thread at the top of the
// rail), and the control settles on "Sent to <thread>". The same act runs from
// `C` in the rail and `:bb-emit review.send` (`space u C` in Helix).
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { cn } from "@/lib/utils";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { prefersReducedMotion, ShortcutHint, ThreadChip } from "../../kit";
import { u } from "../keys";
import { startFlight } from "../../kit/handoff/flight";
import { useHelixRpc, type Rpc } from "../data";
import { refetchComments, useComments } from "../rail/commentsStore";

type Sent = { threadId: string; title: string; at: number } | { error: string; at: number } | null;
const last = new Map<string, Sent>();
const listeners = new Set<() => void>();
const origins = new Map<string, HTMLElement>();

function setLast(threadId: string, value: Sent) {
  last.set(threadId, value);
  for (const l of listeners) l();
}

/** A send just finished (its "Sent to" or its error is showing). */
export function useRecentSend(threadId: string): boolean {
  return useLast(threadId) !== null;
}

function useLast(threadId: string): Sent {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => last.get(threadId) ?? null,
  );
}

/** Where the packet lands: the chat's composer when it is on screen, else the rail's thread. */
function landing(threadId: string): Element | null {
  const composers = Array.from(document.querySelectorAll<HTMLElement>("[contenteditable='true']")).filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.right > 0 && r.left < window.innerWidth;
  });
  const composer = composers.find((el) => !el.closest("[data-helix-rail], [data-helix-comment-box]"));
  return composer ?? document.querySelector(`[data-helix-rail] [data-kit-thread-chip="${CSS.escape(threadId)}"]`) ?? origins.get(threadId) ?? null;
}

/** Send the thread's comments not sent yet. Safe to call from a key or a Helix action. */
export async function sendComments(rpc: Rpc, threadId: string, scope: Record<string, string>): Promise<void> {
  const sources = Array.from(document.querySelectorAll<HTMLElement>(`[data-helix-comment-state="unsent"]`)).filter((el) => el.getBoundingClientRect().height > 0);
  const flight = prefersReducedMotion()
    ? null
    : startFlight({ sources, origin: origins.get(threadId) ?? null, target: () => landing(threadId), label: sources.length > 1 ? `${sources.length} comments` : "Comment", scope });
  try {
    const { message } = await rpc.call("sendReviewComments", { threadId });
    await flight?.finished;
    const title = message.startsWith("Sent to ") ? message.slice("Sent to ".length) : null;
    setLast(threadId, title ? { threadId, title, at: Date.now() } : { error: message, at: Date.now() });
  } catch (cause) {
    await flight?.returnHome();
    setLast(threadId, { error: cause instanceof Error ? cause.message : String(cause), at: Date.now() });
  } finally {
    void refetchComments(rpc, threadId);
  }
}

/** The control: the count of comments not sent yet, the verb, its key, and afterwards where they went. */
export function SendToThread({ threadId, className }: { threadId: string; className?: string }) {
  const rpc = useHelixRpc();
  const scope = usePortalScopeProps() as unknown as Record<string, string>;
  const { data } = useComments(threadId);
  const sent = useLast(threadId);
  const [busy, setBusy] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const unsent = data?.unsent ?? 0;

  useEffect(() => {
    const el = button.current;
    if (!el) return;
    origins.set(threadId, el);
    return () => {
      if (origins.get(threadId) === el) origins.delete(threadId);
    };
  });

  // "Sent to" stays a moment, then the control is quiet again.
  useEffect(() => {
    if (!sent) return;
    const timer = window.setTimeout(() => setLast(threadId, null), "error" in sent ? 6000 : 4000);
    return () => window.clearTimeout(timer);
  }, [sent, threadId]);

  if (sent && !("error" in sent) && unsent === 0) return <ThreadChip threadId={sent.threadId} title={sent.title} prefix="Sent to" className={className} />;
  if (unsent === 0 && !sent) return null;
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      {sent && "error" in sent ? (
        <span className="max-w-64 truncate text-xs text-destructive" role="status">
          {sent.error}
        </span>
      ) : null}
      {unsent > 0 ? (
        <button
          ref={button}
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void sendComments(rpc, threadId, scope).finally(() => setBusy(false));
          }}
          title="Send to thread (space u C in Helix, C in the rail)"
          className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md bg-primary px-2 text-xs font-medium text-primary-foreground transition-opacity duration-[120ms] hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
          data-helix-send-comments
        >
          Send to thread
          <span className="tabular-nums opacity-80">{unsent}</span>
          <ShortcutHint combo={u("shift+c")} className="text-primary-foreground/80 [&_kbd]:border-primary-foreground/30 [&_kbd]:bg-transparent [&_kbd]:text-primary-foreground" />
        </button>
      ) : null}
    </span>
  );
}
