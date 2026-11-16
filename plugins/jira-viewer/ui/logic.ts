// Pure UI logic: routes, search input, grouping, selection, changed rows and
// failure copy. No React here, so it is unit-tested directly.
import { ISSUE_KEY_PATTERN, type Failure, type IssueRow, type StatusCategory } from "../src/schemas.js";

// ---------------------------------------------------------------- routes

/** Where the list comes from. */
export type ListSource = { kind: "view"; viewId: string } | { kind: "search"; jql: string };

export interface PageRoute {
  /** Null when the URL names only an issue: use the last list source. */
  source: ListSource | null;
  issueKey: string | null;
}

export const DEFAULT_SOURCE: ListSource = { kind: "view", viewId: "my-open" };

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Panel subPath grammar (segments percent-encoded by bb):
 *   ""                       default view
 *   "views/<id>"             a saved view
 *   "search/<jql>"           ad-hoc JQL
 *   "<route>/<KEY>"          any of the above with an issue open
 *   "<KEY>"                  the cross-plugin route: an issue, list from last source
 */
export function parseSubPath(subPath: string): PageRoute {
  const segments = subPath.split("/").filter((segment) => segment !== "").map(decode);
  let issueKey: string | null = null;
  const last = segments[segments.length - 1];
  if (last !== undefined && ISSUE_KEY_PATTERN.test(last) && !(segments.length === 2 && segments[0] === "views")) {
    issueKey = last.toUpperCase();
    segments.pop();
  }
  let source: ListSource | null = null;
  if (segments[0] === "views" && segments[1]) source = { kind: "view", viewId: segments[1] };
  else if (segments[0] === "search" && segments.length > 1) {
    const jql = segments.slice(1).join("/").trim();
    if (jql !== "") source = { kind: "search", jql };
  }
  if (source === null && issueKey === null) source = DEFAULT_SOURCE;
  return { source, issueKey };
}

/** The unencoded subPath for bb's `toPluginPanel(path, { subPath })`. */
export function formatSubPath(source: ListSource | null, issueKey: string | null = null): string {
  const parts: string[] = [];
  if (source?.kind === "view") parts.push("views", source.viewId);
  if (source?.kind === "search") parts.push("search", source.jql);
  if (issueKey) parts.push(issueKey);
  return parts.join("/");
}

export function sameSource(a: ListSource | null, b: ListSource | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind === "view" && b.kind === "view") return a.viewId === b.viewId;
  if (a.kind === "search" && b.kind === "search") return a.jql === b.jql;
  return false;
}

// ---------------------------------------------------------------- search

export type SearchIntent =
  | { kind: "empty" }
  | { kind: "key"; key: string; jql: string }
  | { kind: "jql"; jql: string }
  | { kind: "text"; text: string; jql: string };

/**
 * JQL needs an operator, a function call, or an uppercase keyword. Plain words
 * ("retry and queue") stay a text search, so lowercase "and" is not JQL.
 */
const JQL_SIGNS = /(!=|<=|>=|[=<>~]|\w\(|\b(AND|OR|NOT|IN|IS|WAS|ORDER BY)\b)/;

/** Decide what the search box means: an issue key, JQL, or words. */
export function classifySearch(input: string): SearchIntent {
  const value = input.trim();
  if (value === "") return { kind: "empty" };
  if (ISSUE_KEY_PATTERN.test(value)) {
    const key = value.toUpperCase();
    return { kind: "key", key, jql: `key = ${key}` };
  }
  if (JQL_SIGNS.test(value)) return { kind: "jql", jql: value };
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return { kind: "text", text: value, jql: `text ~ "${escaped}" ORDER BY updated DESC` };
}

// ---------------------------------------------------------------- groups

export const CATEGORY_ORDER: readonly StatusCategory[] = ["in_progress", "todo", "done"];

export const CATEGORY_LABEL: Record<StatusCategory, string> = {
  in_progress: "In progress",
  todo: "To do",
  done: "Done",
};

export interface IssueGroup {
  category: StatusCategory;
  label: string;
  issues: IssueRow[];
}

/** Group rows by status category, keeping Jira's order inside each group. */
export function groupIssues(issues: readonly IssueRow[]): IssueGroup[] {
  return CATEGORY_ORDER.map((category) => ({
    category,
    label: CATEGORY_LABEL[category],
    issues: issues.filter((issue) => issue.statusCategory === category),
  })).filter((group) => group.issues.length > 0);
}

/** The rows in visual order: what j/k walks through. */
export function visualOrder(groups: readonly IssueGroup[]): string[] {
  return groups.flatMap((group) => group.issues.map((issue) => issue.key));
}

// ---------------------------------------------------------------- selection

/** Move the selection by `delta` through `order`, clamping at the ends. */
export function moveSelection(order: readonly string[], current: string | null, delta: number): string | null {
  if (order.length === 0) return null;
  const index = current === null ? -1 : order.indexOf(current);
  if (index === -1) return delta >= 0 ? order[0]! : order[order.length - 1]!;
  const next = Math.max(0, Math.min(order.length - 1, index + delta));
  return order[next]!;
}

/** Keep a selection valid when the list changes: same key, else its old neighbour. */
export function reconcileSelection(
  previousOrder: readonly string[],
  nextOrder: readonly string[],
  current: string | null,
): string | null {
  if (current === null || nextOrder.includes(current)) return current;
  const index = previousOrder.indexOf(current);
  if (index === -1 || nextOrder.length === 0) return nextOrder[0] ?? null;
  for (let offset = 1; offset < previousOrder.length; offset++) {
    const after = previousOrder[index + offset];
    if (after !== undefined && nextOrder.includes(after)) return after;
    const before = previousOrder[index - offset];
    if (before !== undefined && nextOrder.includes(before)) return before;
  }
  return nextOrder[0] ?? null;
}

// ---------------------------------------------------------------- changes

/**
 * Keys whose `updated` changed since the last snapshot. The first snapshot
 * (previous null) reports nothing: content appears in place on load.
 */
export function changedKeys(
  previous: ReadonlyMap<string, string | null> | null,
  issues: readonly IssueRow[],
): Set<string> {
  const changed = new Set<string>();
  if (previous === null) return changed;
  for (const issue of issues) {
    if (previous.has(issue.key) && previous.get(issue.key) !== issue.updated) changed.add(issue.key);
  }
  return changed;
}

export function snapshot(issues: readonly IssueRow[]): Map<string, string | null> {
  return new Map(issues.map((issue) => [issue.key, issue.updated]));
}

// ---------------------------------------------------------------- copy

export interface FailureCopy {
  title: string;
  description: string;
  /** What the primary action does. */
  action: "settings" | "retry" | "check" | "none";
  actionLabel: string;
}

/** What failed and how to fix it, without apology. */
export function failureCopy(failure: Failure): FailureCopy {
  switch (failure.kind) {
    case "not_configured":
      return {
        title: "Connect Jira",
        description: "Add your Jira site, account email and an API token in settings. The token stays on the bb server.",
        action: "settings",
        actionLabel: "Open settings",
      };
    case "unauthorized":
      return {
        title: "Jira rejected the email or API token",
        // The CAPTCHA lockout has its own instruction; otherwise say what to check.
        description: /browser/i.test(failure.message)
          ? failure.message
          : "Check the account email and API token in settings. Create a new token at id.atlassian.com if the old one was revoked.",
        action: "settings",
        actionLabel: "Open settings",
      };
    case "forbidden":
      return {
        title: "This account cannot see that",
        description: failure.message.replace(/^Jira says this account may not do that:\s*/, ""),
        action: "retry",
        actionLabel: "Try again",
      };
    case "not_found":
      return {
        title: "Not in Jira",
        description: "It was deleted, moved, or this account cannot see it.",
        action: "none",
        actionLabel: "",
      };
    case "rate_limited": {
      const seconds = failure.retryAfterMs ? Math.ceil(failure.retryAfterMs / 1000) : null;
      return {
        title: "Jira is rate limiting requests",
        description: seconds ? `Showing cached issues. Jira accepts requests again in ${seconds} s.` : "Showing cached issues. Try again shortly.",
        action: "retry",
        actionLabel: "Try again",
      };
    }
    case "bad_request":
      return {
        title: "Jira could not run this search",
        description: failure.message.replace(/^Jira could not run that:\s*/, ""),
        action: "none",
        actionLabel: "",
      };
    case "timeout":
      return { title: "Jira did not answer in time", description: failure.message, action: "retry", actionLabel: "Try again" };
    case "network":
      return { title: "Jira is unreachable", description: failure.message, action: "check", actionLabel: "Check connection" };
    case "server":
      return { title: "Jira had a problem", description: failure.message, action: "retry", actionLabel: "Try again" };
    case "invalid_response":
      return {
        title: "That site does not answer like Jira Cloud",
        description: failure.message,
        action: "settings",
        actionLabel: "Open settings",
      };
  }
}

// ---------------------------------------------------------------- time

/** "now", "5m", "3h", "2d", or a short date: compact for rows and meta lines. */
export function shortAge(iso: string | null, now: number): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const minutes = Math.round((now - then) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d`;
  return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** First name for dense rows: "Ana Ruiz" becomes "Ana". */
export function shortName(displayName: string | null | undefined): string {
  if (!displayName) return "";
  return displayName.trim().split(/\s+/)[0] ?? displayName;
}
