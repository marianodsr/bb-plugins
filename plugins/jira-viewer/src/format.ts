// Plain-text and Markdown renderings for the CLI, agent tools, mention
// context and Task Board bodies. Everything here is bounded.
import type { Failure, IssueDocument, IssueRow, StatusResult, View } from "./schemas.js";

export interface DocumentLimits {
  maxDescriptionChars: number;
  maxComments: number;
  maxCommentChars: number;
  includeComments: boolean;
}

export const TOOL_DOCUMENT_LIMITS: DocumentLimits = {
  maxDescriptionChars: 8_000,
  maxComments: 10,
  maxCommentChars: 1_500,
  includeComments: true,
};

export const MENTION_DOCUMENT_LIMITS: DocumentLimits = {
  maxDescriptionChars: 6_000,
  maxComments: 5,
  maxCommentChars: 1_000,
  includeComments: true,
};

export const TASK_BODY_LIMITS: DocumentLimits = {
  maxDescriptionChars: 4_000,
  maxComments: 0,
  maxCommentChars: 0,
  includeComments: false,
};

/**
 * Cut Markdown at a line boundary near `max` characters, closing an open
 * code fence so the rest of the document does not render as code.
 */
export function truncateMarkdown(markdown: string, max: number): { text: string; truncated: boolean } {
  if (markdown.length <= max) return { text: markdown, truncated: false };
  let cut = markdown.slice(0, max);
  const lastBreak = cut.lastIndexOf("\n");
  if (lastBreak > max * 0.6) cut = cut.slice(0, lastBreak);
  const fences = cut.match(/^(`{3,}|~{3,})/gm) ?? [];
  if (fences.length % 2 === 1) cut += `\n${fences[fences.length - 1]}`;
  return { text: cut.trimEnd(), truncated: true };
}

/**
 * Push headings down so a document's own `#`/`##` nest under the section
 * that contains them. Lines inside code fences are left alone.
 */
export function nestHeadings(markdown: string, minLevel: number): string {
  let fence: string | null = null;
  let shift: number | null = null;
  const lines = markdown.split("\n");
  for (const line of lines) {
    const open = /^(`{3,}|~{3,})/.exec(line);
    if (open) fence = fence === null ? open[1]! : line.startsWith(fence) ? null : fence;
    else if (fence === null) {
      const heading = /^(#{1,6}) /.exec(line);
      if (heading) shift = Math.min(shift ?? 6, heading[1]!.length);
    }
  }
  if (shift === null || shift >= minLevel) return markdown;
  const by = minLevel - shift;
  fence = null;
  return lines
    .map((line) => {
      const open = /^(`{3,}|~{3,})/.exec(line);
      if (open) {
        fence = fence === null ? open[1]! : line.startsWith(fence) ? null : fence;
        return line;
      }
      if (fence !== null) return line;
      return line.replace(/^(#{1,6}) /, (_match, hashes: string) => `${"#".repeat(Math.min(6, hashes.length + by))} `);
    })
    .join("\n");
}

export function relativeTime(iso: string | null, now: number): string {
  if (!iso) return "unknown";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "unknown";
  const seconds = Math.round((now - then) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 60) return `${days}d ago`;
  return iso.slice(0, 10);
}

function cell(value: string, width: number): string {
  const clean = value.replace(/\s+/g, " ");
  if (clean.length <= width) return clean.padEnd(width);
  return `${clean.slice(0, width - 1)}…`;
}

/** Fixed-width table for terminals and agents. */
export function formatRows(rows: readonly IssueRow[], now: number): string {
  if (rows.length === 0) return "No issues match.";
  const keyWidth = Math.max(3, ...rows.map((row) => row.key.length));
  const statusWidth = Math.min(16, Math.max(6, ...rows.map((row) => row.status.length)));
  const header = `${cell("Key", keyWidth)}  ${cell("Status", statusWidth)}  ${cell("Assignee", 16)}  ${cell("Updated", 9)}  Summary`;
  const lines = rows.map(
    (row) =>
      `${cell(row.key, keyWidth)}  ${cell(row.status, statusWidth)}  ${cell(row.assignee?.displayName ?? "Unassigned", 16)}  ${cell(relativeTime(row.updated, now), 9)}  ${row.summary.replace(/\s+/g, " ").slice(0, 160)}`,
  );
  return [header, ...lines].join("\n");
}

function metaLine(doc: IssueDocument): string[] {
  const lines = [
    `- Status: ${doc.status}`,
    `- Type: ${doc.issueType ?? "unknown"}`,
    `- Priority: ${doc.priority ?? "none"}`,
    `- Assignee: ${doc.assignee?.displayName ?? "Unassigned"}`,
    `- Reporter: ${doc.reporter?.displayName ?? "unknown"}`,
  ];
  if (doc.projectKey) lines.push(`- Project: ${doc.projectName ?? doc.projectKey} (${doc.projectKey})`);
  if (doc.parent) lines.push(`- Parent: ${doc.parent.key} ${doc.parent.summary}`);
  if (doc.labels.length > 0) lines.push(`- Labels: ${doc.labels.join(", ")}`);
  if (doc.components.length > 0) lines.push(`- Components: ${doc.components.join(", ")}`);
  if (doc.fixVersions.length > 0) lines.push(`- Fix versions: ${doc.fixVersions.join(", ")}`);
  if (doc.resolution) lines.push(`- Resolution: ${doc.resolution}`);
  if (doc.dueDate) lines.push(`- Due: ${doc.dueDate}`);
  if (doc.created) lines.push(`- Created: ${doc.created}`);
  if (doc.updated) lines.push(`- Updated: ${doc.updated}`);
  return lines;
}

/** The issue as one Markdown document, bounded by `limits`. */
export function formatDocument(doc: IssueDocument, limits: DocumentLimits): string {
  const parts: string[] = [`# ${doc.key}: ${doc.summary}`, doc.url, metaLine(doc).join("\n")];

  const description = doc.description.trim();
  if (description === "") {
    parts.push("## Description\n\nNo description.");
  } else {
    const { text, truncated } = truncateMarkdown(nestHeadings(description, 3), limits.maxDescriptionChars);
    parts.push(
      `## Description\n\n${text}${truncated ? `\n\n*Description truncated at ${limits.maxDescriptionChars} characters; the full text is in Jira.*` : ""}`,
    );
  }

  if (doc.subtasks.length > 0) {
    const done = doc.subtasks.filter((task) => task.statusCategory === "done").length;
    parts.push(
      `## Subtasks (${done} of ${doc.subtasks.length} done)\n\n${doc.subtasks
        .slice(0, 50)
        .map((task) => `- ${task.key} [${task.status ?? "unknown"}] ${task.summary}`)
        .join("\n")}`,
    );
  }

  if (doc.links.length > 0) {
    parts.push(
      `## Links\n\n${doc.links
        .slice(0, 50)
        .map((link) => `- ${link.label} ${link.issue.key} [${link.issue.status ?? "unknown"}] ${link.issue.summary}`)
        .join("\n")}`,
    );
  }

  if (doc.attachments.length > 0) {
    parts.push(
      `## Attachments\n\n${doc.attachments
        .slice(0, 30)
        .map((file) => `- ${file.filename}${file.mimeType ? ` (${file.mimeType})` : ""}`)
        .join("\n")}`,
    );
  }

  if (limits.includeComments && limits.maxComments > 0) {
    if (doc.commentsTotal === 0) {
      parts.push("## Comments\n\nNo comments.");
    } else {
      const shown = doc.comments.slice(-limits.maxComments);
      const header =
        shown.length < doc.commentsTotal
          ? `## Comments (latest ${shown.length} of ${doc.commentsTotal})`
          : `## Comments (${doc.commentsTotal})`;
      const bodies = shown.map((comment) => {
        const { text, truncated } = truncateMarkdown(nestHeadings(comment.body.trim() || "(empty)", 4), limits.maxCommentChars);
        return `### ${comment.author?.displayName ?? "Unknown"}, ${comment.created ?? "unknown date"}\n\n${text}${truncated ? "\n\n*Comment truncated.*" : ""}`;
      });
      parts.push([header, ...bodies].join("\n\n"));
    }
  }
  return parts.join("\n\n");
}

export function formatFailure(failure: Failure): string {
  const retry =
    failure.kind === "rate_limited" && failure.retryAfterMs !== null
      ? ` (retry after ${Math.ceil(failure.retryAfterMs / 1000)} s)`
      : "";
  return `${failure.message}${retry}`;
}

export function formatStatus(status: StatusResult): string {
  const lines = [`State: ${status.state.replace("_", " ")}`];
  lines.push(`Site: ${status.siteUrl ?? "not set"}`);
  lines.push(`Email: ${status.email ?? "not set"}`);
  if (status.usingOverride) lines.push("API base URL override: on (development)");
  if (status.missing.length > 0) lines.push(`Missing: ${status.missing.join(", ")}`);
  if (status.account) lines.push(`Signed in as: ${status.account.displayName}`);
  if (status.error) lines.push(`Last error: ${status.error.kind}: ${formatFailure(status.error)}`);
  lines.push(`Task Board: ${status.integrations.taskBoard ? "available" : "not installed"}`);
  if (!status.configured) {
    lines.push(
      "",
      "Set up with:",
      "  bb plugin config jira-viewer set site <your-site>.atlassian.net",
      "  bb plugin config jira-viewer set email <you@example.com>",
      "  then add the API token in Settings → Installed plugins → Jira Viewer",
    );
  }
  return lines.join("\n");
}

export function formatViews(views: readonly View[]): string {
  if (views.length === 0) return "No saved views.";
  const idWidth = Math.max(2, ...views.map((view) => view.id.length));
  const nameWidth = Math.min(32, Math.max(4, ...views.map((view) => view.name.length)));
  return [
    `${cell("Id", idWidth)}  ${cell("Name", nameWidth)}  JQL`,
    ...views.map((view) => `${cell(view.id, idWidth)}  ${cell(view.name, nameWidth)}  ${view.jql}`),
  ].join("\n");
}

/** Quote user words for a JQL `text ~` clause. */
export function textQueryJql(query: string): string {
  const escaped = query.trim().replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `text ~ "${escaped}" ORDER BY updated DESC`;
}

/** Quote one argument for a POSIX shell. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
