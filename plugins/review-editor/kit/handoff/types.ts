// GENERATED from /kit by kit/scripts/sync.mjs (kit 36f976388355). Do not edit; change /kit and re-sync.
import type { JsonValue, NewThreadRequest } from "@get-bb/plugin-sdk/app";
import type { RunStatus } from "../components/StatusDot";

export type JsonObject = { [key: string]: JsonValue };

/** Where a handoff goes. */
export type HandoffTarget =
  /** The thread this surface belongs to: draft into its composer, or send now. */
  | { kind: "current"; threadId: string; mode: "insert" | "send" }
  /** Any other thread, picked by the user. */
  | { kind: "thread"; threadId: string }
  /** A new thread created through bb's new-thread composer. */
  | { kind: "new" };

export type HandoffDelivery = "inserted" | "sent" | "queued" | "created";

/** What the caller gets back once the receiving thread has the work. */
export interface HandoffResult {
  target: HandoffTarget;
  delivery: HandoffDelivery;
  threadId: string;
  threadTitle: string;
  /** Keys of the items that were handed off. */
  itemKeys: string[];
  /** The exact prompt text delivered. */
  prompt: string;
  at: number;
}

/** A thread the picker can offer. Live by default; settable for demos and tests. */
export interface HandoffThread {
  id: string;
  title: string;
  status: RunStatus;
  statusLabel?: string;
  projectId?: string;
  projectName?: string;
  /** Sort key, newest first. */
  updatedAt?: number;
}

/**
 * The side effects of a handoff. The default transport uses bb's SDK
 * (`useComposers`, `threads.send`, `threads.spawn`, `updatePluginMetadata`);
 * pass your own only for demos and tests.
 */
export interface HandoffTransport {
  /** Draft the prompt into the thread's on-screen composer. */
  insert(threadId: string, prompt: string, metadata: JsonObject | undefined): Promise<void> | void;
  /** Deliver the prompt as a message now (queued behind a running turn). */
  send(
    threadId: string,
    prompt: string,
    metadata: JsonObject | undefined,
  ): Promise<"sent" | "queued">;
  /** Create the thread from the new-thread composer's request. */
  spawn(
    request: NewThreadRequest,
    metadata: JsonObject | undefined,
    title: string | undefined,
  ): Promise<{ id: string; title: string | null }>;
}
