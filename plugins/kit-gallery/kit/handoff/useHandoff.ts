// GENERATED from /kit by kit/scripts/sync.mjs (kit 36f976388355). Do not edit; change /kit and re-sync.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  experimental_useSidebarThreads as useSidebarThreads,
  useComposers,
  useSdk,
  type NewThreadRequest,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { usePortalScopeProps } from "../../lib/portal-scope";
import { prefersReducedMotion } from "../motion";
import { threadRunStatus } from "../components/StatusDot";
import { startFlight, targets, type Flight } from "./flight";
import type {
  HandoffDelivery,
  HandoffResult,
  HandoffTarget,
  HandoffThread,
  HandoffTransport,
  JsonObject,
} from "./types";

export interface UseHandoffOptions<T> {
  /** The selection to hand off. An empty list disables Send to thread. */
  items: readonly T[];
  getKey: (item: T) => string;
  /** The prompt the receiving thread gets. Shown in the sheet's preview. */
  buildPrompt: (items: readonly T[], target: HandoffTarget) => string;
  /** Stored on the receiving thread with `updatePluginMetadata` (or at spawn). */
  pluginMetadata?: (items: readonly T[], target: HandoffTarget) => JsonObject | undefined;
  /** Nouns for labels: "Send 3 comments". */
  noun?: { one: string; many: string };
  /** The thread this surface belongs to; enables the "This thread" targets. */
  currentThreadId?: string | null;
  /** Seeds the new-thread project and ranks this project's threads first. */
  projectId?: string | null;
  /** Title for a thread created by the handoff. */
  newThreadTitle?: (items: readonly T[]) => string | undefined;
  /** Runs after the receiving thread has the work. Persist "sent" state here. */
  onSent?: (result: HandoffResult, items: readonly T[]) => void | Promise<void>;
  /** A key that opens the sheet, e.g. "s". Shown on the button. */
  hotkey?: string;
  /** Demo and test seams. Leave unset in real plugins. */
  transport?: HandoffTransport;
  threads?: readonly HandoffThread[];
}

export type HandoffPhase = "idle" | "sending" | "sent" | "failed";

export interface Handoff<T> {
  items: readonly T[];
  count: number;
  label: string;
  /** Ref callback for each source item's element: `ref={handoff.itemRef(key)}`. */
  itemRef: (key: string) => (el: HTMLElement | null) => void;
  /** The Send control. `HandoffSheet` attaches it for you. */
  originRef: (el: HTMLElement | null) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
  newThreadOpen: boolean;
  setNewThreadOpen: (open: boolean) => void;
  phase: HandoffPhase;
  lastResult: HandoffResult | null;
  error: string | null;
  /** Send to a thread target. Resolves with the result; rejects on failure. */
  send: (target: Exclude<HandoffTarget, { kind: "new" }>) => Promise<HandoffResult>;
  /** Open the new-thread composer with the prompt seeded. */
  startNewThread: () => void;
  /** Called by the new-thread composer on submit. */
  submitNewThread: (request: NewThreadRequest) => Promise<void>;
  buildPrompt: (target: HandoffTarget) => string;
  threads: readonly HandoffThread[];
  currentThread: HandoffThread | null;
  canInsert: boolean;
  projectId: string | null;
  hotkey: string | undefined;
  draftKey: string;
  clearResult: () => void;
}

const pluralize = (n: number, noun: { one: string; many: string }) =>
  `${n} ${n === 1 ? noun.one : noun.many}`;

/**
 * The handoff: take what the user is looking at and send it to a thread.
 * Pair with `<HandoffSheet handoff={...} />` (button, target picker, prompt
 * preview, new-thread dialog) and `<SentChip result={handoff.lastResult} />`.
 *
 * ```tsx
 * const handoff = useHandoff({
 *   items: openComments,
 *   getKey: (c) => c.id,
 *   buildPrompt: (cs) => compileReviewPrompt(cs),
 *   pluginMetadata: (cs) => ({ reviewCommentIds: cs.map((c) => c.id) }),
 *   noun: { one: "comment", many: "comments" },
 *   currentThreadId: threadId,
 *   hotkey: "s",
 *   onSent: (result, cs) => markSent(cs, result.threadId),
 * });
 * {comments.map((c) => <CommentRow key={c.id} ref={handoff.itemRef(c.id)} ... />)}
 * <HandoffSheet handoff={handoff} />
 * <SentChip result={handoff.lastResult} />
 * ```
 */
export function useHandoff<T>(options: UseHandoffOptions<T>): Handoff<T> {
  const {
    items,
    getKey,
    noun = { one: "item", many: "items" },
    currentThreadId = null,
    projectId = null,
    hotkey,
  } = options;
  const latest = useRef(options);
  latest.current = options;

  const sdk = useSdk();
  const composers = useComposers();
  const live = useSidebarThreads();
  const scope = usePortalScopeProps() as unknown as Record<string, string>;

  const elements = useRef(new Map<string, HTMLElement>());
  const refCache = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const origin = useRef<HTMLElement | null>(null);
  const flight = useRef<Flight | null>(null);

  const [open, setOpen] = useState(false);
  const [newThreadOpen, setNewThreadOpen] = useState(false);
  const [phase, setPhase] = useState<HandoffPhase>("idle");
  const [lastResult, setLastResult] = useState<HandoffResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => flight.current?.cancel(), []);

  const itemRef = useCallback((key: string) => {
    let ref = refCache.current.get(key);
    if (!ref) {
      ref = (el: HTMLElement | null) => {
        if (el) elements.current.set(key, el);
        else elements.current.delete(key);
      };
      refCache.current.set(key, ref);
    }
    return ref;
  }, []);
  const originRef = useCallback((el: HTMLElement | null) => {
    origin.current = el;
  }, []);

  const projectNames = useMemo(
    () => new Map(live.projects.map((p) => [p.id, p.name])),
    [live.projects],
  );
  const liveThreads = useMemo<HandoffThread[]>(
    () =>
      live.threads
        .filter((t) => !t.isHidden && !t.isArchived)
        .map((t) => ({
          id: t.id,
          title: t.displayTitle,
          status: threadRunStatus(t),
          statusLabel: t.indicatorLabel ?? undefined,
          projectId: t.projectId,
          projectName: projectNames.get(t.projectId),
          updatedAt: Math.max(t.latestAttentionAt ?? 0, t.updatedAt ?? 0),
        })),
    [live.threads, projectNames],
  );
  const allThreads = options.threads ?? liveThreads;
  const currentThread = useMemo(
    () => (currentThreadId ? (allThreads.find((t) => t.id === currentThreadId) ?? null) : null),
    [allThreads, currentThreadId],
  );
  const threads = useMemo(
    () =>
      allThreads
        .filter((t) => t.id !== currentThreadId)
        .slice()
        .sort((a, b) => {
          const ap = projectId && a.projectId === projectId ? 1 : 0;
          const bp = projectId && b.projectId === projectId ? 1 : 0;
          return bp - ap || (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
        }),
    [allThreads, currentThreadId, projectId],
  );

  const currentComposer = currentThreadId
    ? composers.find((c) => c.scope.kind === "thread" && c.scope.threadId === currentThreadId)
    : undefined;
  const canInsert = Boolean(options.transport || currentComposer);

  const transport = useMemo<HandoffTransport>(
    () =>
      options.transport ?? {
        insert: async (threadId, prompt, metadata) => {
          const composer = composersRef.current.find(
            (c) => c.scope.kind === "thread" && c.scope.threadId === threadId,
          );
          if (!composer) {
            throw new Error("This thread's composer is not on screen. Use Send now instead.");
          }
          if (metadata) await sdk.threads.updatePluginMetadata({ threadId, set: metadata });
          composer.insert(prompt, { at: "end", block: true });
          composer.focus();
        },
        send: async (threadId, prompt, metadata) => {
          if (metadata) await sdk.threads.updatePluginMetadata({ threadId, set: metadata });
          const result = await sdk.threads.send({
            threadId,
            input: [{ type: "text", text: prompt, mentions: [] }],
            mode: "queue-if-active",
          });
          return result.delivery === "queued" ? "queued" : "sent";
        },
        spawn: async (request, metadata, title) => {
          const thread = await sdk.threads.spawn({
            ...request,
            ...(metadata ? { pluginMetadata: metadata } : {}),
            ...(title ? { title } : {}),
          });
          return { id: thread.id, title: thread.title ?? null };
        },
      },
    [options.transport, sdk],
  );
  const composersRef = useRef(composers);
  composersRef.current = composers;

  const label = pluralize(items.length, noun);
  const keys = items.map(getKey);
  const draftKey = `kit-handoff:${keys.slice().sort().join(",").slice(0, 200)}`;

  const buildPrompt = useCallback(
    (target: HandoffTarget) => latest.current.buildPrompt(latest.current.items, target),
    [],
  );

  const fly = (target: () => Element | null) => {
    flight.current?.cancel();
    if (prefersReducedMotion()) {
      flight.current = null;
      return;
    }
    const sources = keys.map((k) => elements.current.get(k)).filter((el): el is HTMLElement => !!el);
    flight.current = startFlight({ sources, origin: origin.current, target, label, scope });
  };

  const titleOf = (threadId: string, fallback: string) =>
    allThreads.find((t) => t.id === threadId)?.title ?? fallback;

  const complete = async (
    target: HandoffTarget,
    delivery: HandoffDelivery,
    threadId: string,
    threadTitle: string,
    prompt: string,
    sent: readonly T[],
  ) => {
    const result: HandoffResult = {
      target,
      delivery,
      threadId,
      threadTitle,
      itemKeys: sent.map(latest.current.getKey),
      prompt,
      at: Date.now(),
    };
    setLastResult(result);
    setPhase("sent");
    setError(null);
    if (delivery === "inserted") toast.success(`Added to the composer of ${threadTitle}`);
    else toast.success(`Sent to ${threadTitle}`);
    await latest.current.onSent?.(result, sent);
    return result;
  };

  const fail = (cause: unknown) => {
    const message = cause instanceof Error ? cause.message : String(cause);
    setPhase("failed");
    setError(message);
    void flight.current?.returnHome();
    toast.error(`Not sent: ${message}`);
  };

  const send = async (target: Exclude<HandoffTarget, { kind: "new" }>) => {
    const sent = latest.current.items;
    if (sent.length === 0) throw new Error("Nothing selected to send.");
    const prompt = latest.current.buildPrompt(sent, target);
    const metadata = latest.current.pluginMetadata?.(sent, target);
    setOpen(false);
    setPhase("sending");
    const threadId = target.threadId;
    fly(() =>
      target.kind === "current"
        ? (targets.composer() ?? targets.sidebarRow(threadId))
        : (targets.sidebarRow(threadId) ?? document.querySelector(`[data-kit-handoff-row="${CSS.escape(threadId)}"]`)),
    );
    try {
      let delivery: HandoffDelivery;
      if (target.kind === "current" && target.mode === "insert") {
        await transport.insert(threadId, prompt, metadata);
        delivery = "inserted";
      } else {
        delivery = await transport.send(threadId, prompt, metadata);
      }
      return await complete(target, delivery, threadId, titleOf(threadId, "thread"), prompt, sent);
    } catch (cause) {
      fail(cause);
      throw cause;
    }
  };

  const startNewThread = () => {
    if (latest.current.items.length === 0) return;
    setOpen(false);
    setNewThreadOpen(true);
    fly(() => {
      const dialog = document.querySelector("[data-kit-handoff-dialog]");
      return targets.composer(dialog) ?? dialog;
    });
  };

  const submitNewThread = async (request: NewThreadRequest) => {
    const sent = latest.current.items;
    const target: HandoffTarget = { kind: "new" };
    const metadata = latest.current.pluginMetadata?.(sent, target);
    const title = latest.current.newThreadTitle?.(sent);
    setPhase("sending");
    try {
      const thread = await transport.spawn(request, metadata, title);
      setNewThreadOpen(false);
      const prompt = latest.current.buildPrompt(sent, target);
      await complete(target, "created", thread.id, thread.title ?? title ?? "New thread", prompt, sent);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setPhase("failed");
      setError(message);
      toast.error(`Thread not created: ${message}`);
      // Rethrow so the composer keeps the draft.
      throw cause;
    }
  };

  return {
    items,
    count: items.length,
    label,
    itemRef,
    originRef,
    open,
    setOpen,
    newThreadOpen,
    setNewThreadOpen,
    phase,
    lastResult,
    error,
    send,
    startNewThread,
    submitNewThread,
    buildPrompt,
    threads,
    currentThread:
      currentThread ??
      (currentThreadId ? { id: currentThreadId, title: "This thread", status: "idle" } : null),
    canInsert,
    projectId,
    hotkey,
    draftKey,
    clearResult: () => {
      setLastResult(null);
      setPhase("idle");
    },
  };
}
