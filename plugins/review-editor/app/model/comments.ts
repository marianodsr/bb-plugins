// Comment helpers shared by the editor and the Review tab: ordering, the
// keyboard walk, severity presentation, and state labels.
import type { TintHue } from "../../kit";
import type { ChangedFile, Comment, CommentState, Severity } from "../../server/contract";

export function byPosition(a: Comment, b: Comment): number {
  return a.startLine - b.startLine || a.endLine - b.endLine || a.createdAt - b.createdAt || a.id.localeCompare(b.id);
}

/** An agent resolved it and the reviewer has not acknowledged that yet. */
export function awaitingAck(comment: Pick<Comment, "state" | "resolvedBy" | "acknowledgedAt">): boolean {
  return comment.state === "resolved" && comment.resolvedBy === "agent" && comment.acknowledgedAt === null;
}

/** Still on the reviewer's plate: unresolved, or resolved by an agent and not yet acknowledged. */
export function needsAttention(comment: Comment): boolean {
  return comment.state !== "resolved" || awaitingAck(comment);
}

/** Comments the walk visits, in file order. */
export function walkable(comments: readonly Comment[], includeResolved = false): Comment[] {
  return comments.filter((comment) => includeResolved || needsAttention(comment)).sort(byPosition);
}

/**
 * The next (`]`) or previous (`[`) comment from the current one, or from the
 * cursor line when none is active. Wraps around the file.
 */
export function step(
  comments: readonly Comment[],
  from: { activeId: string | null; line: number },
  direction: 1 | -1,
): Comment | null {
  const list = walkable(comments);
  if (list.length === 0) return null;
  const index = from.activeId === null ? -1 : list.findIndex((comment) => comment.id === from.activeId);
  if (index !== -1) return list[(index + direction + list.length) % list.length]!;
  if (direction === 1) return list.find((comment) => comment.startLine > from.line) ?? list[0]!;
  return [...list].reverse().find((comment) => comment.startLine < from.line) ?? list[list.length - 1]!;
}

export const SEVERITY_HUE: Record<Severity, TintHue | null> = {
  note: null,
  suggestion: "sky",
  issue: "amber",
  blocker: "red",
};

export const SEVERITY_LABEL: Record<Severity, string> = {
  note: "Note",
  suggestion: "Suggestion",
  issue: "Issue",
  blocker: "Blocker",
};

export const STATE_LABEL: Record<CommentState, string> = {
  open: "Open",
  sent: "Sent",
  resolved: "Resolved",
  outdated: "Outdated",
};

/** Comments the tray hands off: written here and not yet sent anywhere. */
export function sendable(comments: readonly Comment[]): Comment[] {
  return comments.filter((comment) => comment.sentThreadId === null && comment.state !== "resolved").sort(byPosition);
}

export function countByState(comments: readonly Comment[]): Record<CommentState, number> {
  const counts: Record<CommentState, number> = { open: 0, sent: 0, resolved: 0, outdated: 0 };
  for (const comment of comments) counts[comment.state] += 1;
  return counts;
}

export function lineLabel(comment: Pick<Comment, "startLine" | "endLine">): string {
  return comment.startLine === comment.endLine ? `Line ${comment.startLine}` : `Lines ${comment.startLine}-${comment.endLine}`;
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** A comment id made on the client so the comment shows before the server answers. */
export function clientCommentId(random: () => number = Math.random): string {
  let id = "rc_";
  for (let i = 0; i < 10; i += 1) id += ALPHABET[Math.floor(random() * ALPHABET.length)];
  return id;
}

/** "just now", "4 min ago", "3 h ago", then a date. */
export function relativeTime(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** "3 open comments", "3 open, all sent", "3 open, 1 not sent", plus "2 resolved by agent". */
export function trayLabel(unresolved: number, unsent: number, byAgent = 0, compact = false): string {
  const agent = byAgent > 0 ? (compact && unresolved > 0 ? `${byAgent} by agent` : `${byAgent} resolved by agent`) : "";
  let open: string;
  if (unresolved === 0) open = byAgent > 0 ? "" : "No open comments";
  else if (compact) open = `${unresolved} open`;
  else if (unsent === 0) open = `${unresolved} open, all sent`;
  else if (unsent === unresolved) open = `${unresolved} open ${unresolved === 1 ? "comment" : "comments"}`;
  else open = `${unresolved} open, ${unsent} not sent`;
  return [open, agent].filter((part) => part !== "").join(", ");
}


export type ReviewFilter = "open" | "all";

export interface FileGroup {
  path: string;
  change: ChangedFile | null;
  comments: Comment[];
}

export type ReviewRow = { kind: "file"; group: FileGroup } | { kind: "comment"; group: FileGroup; comment: Comment };

/** Files in git order, then files that only have comments; comments under each. */
export function groupReview(changed: readonly ChangedFile[], comments: readonly Comment[], filter: ReviewFilter): FileGroup[] {
  const visible = comments.filter((comment) => filter === "all" || needsAttention(comment));
  const byPath = new Map<string, Comment[]>();
  for (const comment of [...visible].sort(byPosition)) {
    const list = byPath.get(comment.path) ?? [];
    list.push(comment);
    byPath.set(comment.path, list);
  }
  const groups: FileGroup[] = changed.map((change) => ({ path: change.path, change, comments: byPath.get(change.path) ?? [] }));
  const known = new Set(changed.map((change) => change.path));
  for (const [path, list] of [...byPath.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (!known.has(path)) groups.push({ path, change: null, comments: list });
  }
  return groups;
}


/**
 * Thread metadata stored with a handoff (the server's `reviewMetadataSchema`).
 * The server treats it as a hint only: it never grants access.
 */
export function handoffMetadata(items: readonly Pick<Comment, "id">[], environmentId: string, now: number) {
  return {
    review: { version: 1, environmentId, commentIds: items.slice(0, 200).map((comment) => comment.id), sentAt: now },
  };
}
