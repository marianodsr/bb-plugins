// Plain-text views for the CLI and agent tools. Every view is bounded: lists
// are paged by the caller and long bodies and comments are cut here.
import type { Lane, TaskCard, TaskDetail, TaskEvent, ThreadStatusView } from "./schemas.js";

export const BODY_SHOWN_MAX = 4_000;
export const COMMENT_SHOWN_MAX = 600;
export const EVENTS_SHOWN = 15;

export function cap(text: string, max: number, hint?: string): string {
  if (text.length <= max) return text;
  const rest = text.length - max;
  return `${text.slice(0, max)}\n… ${rest} more characters${hint ? ` (${hint})` : ""}`;
}

function laneName(lanes: Map<string, Lane> | undefined, card: TaskCard): string {
  return lanes?.get(card.laneId)?.name ?? card.laneKind;
}

export function cardLine(card: TaskCard, lanes?: Map<string, Lane>): string {
  const facts: string[] = [];
  if (card.priority !== "none") facts.push(`priority ${card.priority}`);
  if (card.labels.length > 0) facts.push(`labels ${card.labels.join(", ")}`);
  if (card.externalRef) facts.push(card.externalRef.key);
  if (card.threadIds.length > 0) facts.push(`${card.threadIds.length} thread${card.threadIds.length === 1 ? "" : "s"}`);
  if (card.commentCount > 0) facts.push(`${card.commentCount} comment${card.commentCount === 1 ? "" : "s"}`);
  if (card.archivedAt !== null) facts.push("archived");
  return `${card.id}  [${laneName(lanes, card)}]  ${card.title}${facts.length ? `  (${facts.join("; ")})` : ""}`;
}

export function listView(
  cards: TaskCard[],
  lanes: Map<string, Lane>,
  page: { offset: number; total: number },
  nextHint: (offset: number) => string,
): string {
  if (cards.length === 0) {
    return page.total === 0 ? "No tasks." : `No tasks at offset ${page.offset} (total ${page.total}).`;
  }
  const lines = cards.map((card) => cardLine(card, lanes));
  const end = page.offset + cards.length;
  lines.push("", `Showing ${page.offset + 1}-${end} of ${page.total}.`);
  if (end < page.total) lines.push(`More: ${nextHint(end)}`);
  return lines.join("\n");
}

function when(ms: number): string {
  return `${new Date(ms).toISOString().replace("T", " ").slice(0, 16)} UTC`;
}

function actorText(event: TaskEvent): string {
  if (event.actor === "agent") return event.actorThreadId ? `agent (${event.actorThreadId})` : "agent";
  return event.actor;
}

export function eventLine(event: TaskEvent): string {
  const payload = event.payload;
  let what: string;
  switch (event.kind) {
    case "commented":
      what = `commented: ${cap(String(payload.body ?? ""), COMMENT_SHOWN_MAX, "tasks show --full")}`;
      break;
    case "moved":
      what = `moved ${String(payload.fromLaneName ?? "?")} → ${String(payload.toLaneName ?? "?")}`;
      break;
    case "updated":
      what = `updated ${Array.isArray(payload.fields) ? payload.fields.join(", ") : ""}`;
      break;
    case "linked":
      what = `linked thread ${String(payload.threadId ?? "")}`;
      break;
    case "unlinked":
      what = `unlinked thread ${String(payload.threadId ?? "")}${payload.reason ? ` (${String(payload.reason)})` : ""}`;
      break;
    case "created":
      what = `created in ${String(payload.laneName ?? "?")}${payload.via ? ` via ${String(payload.via)}` : ""}`;
      break;
    default:
      what = event.kind;
  }
  return `${when(event.createdAt)}  ${actorText(event)}  ${what}`;
}

export function detailView(
  task: TaskDetail,
  statuses: Record<string, ThreadStatusView>,
  options: { full: boolean; events?: number },
): string {
  const lines = [`${task.id}  ${task.title}`];
  const facts = [`lane ${task.laneName} (${task.laneKind})`, `priority ${task.priority}`];
  if (task.labels.length > 0) facts.push(`labels ${task.labels.join(", ")}`);
  if (task.archivedAt !== null) facts.push(`archived ${when(task.archivedAt)}`);
  lines.push(facts.join("; "));
  if (task.externalRef) lines.push(`Jira ${task.externalRef.key}: ${task.externalRef.url}`);
  lines.push(`updated ${when(task.updatedAt)} by ${task.updatedBy}; created ${when(task.createdAt)}`);
  lines.push("");
  const body = task.body.trim();
  lines.push(body ? (options.full ? body : cap(body, BODY_SHOWN_MAX, "use --full")) : "(no description)");
  if (task.threads.length > 0) {
    lines.push("", "Threads:");
    for (const link of task.threads) {
      const status = statuses[link.threadId];
      lines.push(`  ${link.threadId}  ${status?.state ?? "unknown"}  ${status?.title ?? ""}`.trimEnd());
    }
  }
  const shown = task.events.slice(0, options.events ?? EVENTS_SHOWN);
  if (shown.length > 0) {
    lines.push("", "Activity (newest first):");
    for (const event of shown) lines.push(`  ${eventLine(event)}`);
    if (task.events.length > shown.length || task.eventsCursor !== null) lines.push("  …older activity omitted");
  }
  return lines.join("\n");
}

export function lanesView(lanes: Lane[]): string {
  return lanes
    .map((lane) => `${lane.id}  ${lane.name}  (${lane.kind}, ${lane.taskCount} ${lane.taskCount === 1 ? "task" : "tasks"})`)
    .join("\n");
}
