// Raw Jira REST v3 issue JSON to the plugin's row and document shapes.
// Every field is read defensively: Jira omits fields the account cannot see,
// and custom setups rename or drop the standard ones.
import { adfToMarkdown } from "../adf.js";
import type {
  Attachment,
  Comment,
  IssueDocument,
  IssueLink,
  IssueRef,
  IssueRow,
  Person,
  StatusCategory,
} from "../schemas.js";

/** Fields a list row needs. */
export const ROW_FIELDS = [
  "summary",
  "status",
  "issuetype",
  "priority",
  "assignee",
  "project",
  "parent",
  "labels",
  "created",
  "updated",
] as const;

/** Fields the issue document needs. */
export const DOCUMENT_FIELDS = [
  ...ROW_FIELDS,
  "description",
  "reporter",
  "resolution",
  "duedate",
  "components",
  "fixVersions",
  "subtasks",
  "issuelinks",
  "comment",
  "attachment",
] as const;

export const MAX_COMMENTS = 50;
/** Hard cap on stored Markdown per body; the UI and tools cap lower. */
export const MAX_BODY_CHARS = 100_000;

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Rec)
    : {};
}

function text(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function name(value: unknown): string | null {
  const record = rec(value);
  return text(record.name) ?? text(record.value) ?? null;
}

export function browseUrl(siteUrl: string, key: string): string {
  return `${siteUrl.replace(/\/+$/, "")}/browse/${encodeURIComponent(key)}`;
}

export function mapStatusCategory(statusField: unknown): StatusCategory {
  const category = rec(rec(statusField).statusCategory);
  const key = text(category.key);
  if (key === "done") return "done";
  if (key === "indeterminate") return "in_progress";
  // Older payloads only carry the colour name.
  const color = text(category.colorName);
  if (color === "green") return "done";
  if (color === "yellow") return "in_progress";
  return "todo";
}

function person(value: unknown): Person | null {
  const record = rec(value);
  const displayName = text(record.displayName);
  if (!displayName) return null;
  return { accountId: text(record.accountId), displayName };
}

function cap(markdown: string): string {
  if (markdown.length <= MAX_BODY_CHARS) return markdown;
  return `${markdown.slice(0, MAX_BODY_CHARS)}\n\n*Truncated: the rest is in Jira.*`;
}

export function normalizeRow(raw: unknown, siteUrl: string): IssueRow | null {
  const issue = rec(raw);
  const key = text(issue.key);
  if (!key) return null;
  const fields = rec(issue.fields);
  const project = rec(fields.project);
  const parent = rec(fields.parent);
  return {
    key,
    id: text(issue.id) ?? key,
    summary: text(fields.summary) ?? "",
    status: name(fields.status) ?? "Unknown",
    statusCategory: mapStatusCategory(fields.status),
    issueType: name(fields.issuetype),
    priority: name(fields.priority),
    assignee: person(fields.assignee),
    projectKey: text(project.key),
    projectName: text(project.name),
    parentKey: text(parent.key),
    labels: Array.isArray(fields.labels)
      ? fields.labels.filter((label): label is string => typeof label === "string")
      : [],
    created: text(fields.created),
    updated: text(fields.updated),
    url: browseUrl(siteUrl, key),
  };
}

function ref(raw: unknown, siteUrl: string): IssueRef | null {
  const issue = rec(raw);
  const key = text(issue.key);
  if (!key) return null;
  const fields = rec(issue.fields);
  const hasStatus = fields.status !== undefined && fields.status !== null;
  return {
    key,
    summary: text(fields.summary) ?? "",
    status: name(fields.status),
    statusCategory: hasStatus ? mapStatusCategory(fields.status) : null,
    issueType: name(fields.issuetype),
    url: browseUrl(siteUrl, key),
  };
}

function links(raw: unknown, siteUrl: string): IssueLink[] {
  if (!Array.isArray(raw)) return [];
  const out: IssueLink[] = [];
  for (const entry of raw) {
    const link = rec(entry);
    const type = rec(link.type);
    const outward = ref(link.outwardIssue, siteUrl);
    const inward = ref(link.inwardIssue, siteUrl);
    const target = outward ?? inward;
    if (!target) continue;
    const direction = outward ? "outward" : "inward";
    out.push({
      id: text(link.id) ?? `${direction}:${target.key}`,
      type: text(type.name) ?? "Related",
      direction,
      label:
        (direction === "outward" ? text(type.outward) : text(type.inward)) ??
        text(type.name) ??
        "relates to",
      issue: target,
    });
  }
  return out;
}

function comments(raw: unknown): { comments: Comment[]; total: number } {
  const field = rec(raw);
  const list = Array.isArray(field.comments) ? field.comments : [];
  const total = typeof field.total === "number" ? field.total : list.length;
  const latest = list.slice(-MAX_COMMENTS);
  return {
    total: Math.max(total, list.length),
    comments: latest.map((entry, index) => {
      const comment = rec(entry);
      return {
        id: text(comment.id) ?? String(index),
        author: person(comment.author),
        created: text(comment.created),
        updated: text(comment.updated),
        body: cap(adfToMarkdown(comment.body)),
      };
    }),
  };
}

function attachments(raw: unknown): Attachment[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const attachment = rec(entry);
    const id = text(attachment.id);
    const filename = text(attachment.filename);
    if (!id || !filename) return [];
    return [
      {
        id,
        filename,
        mimeType: text(attachment.mimeType),
        size: typeof attachment.size === "number" ? attachment.size : null,
      },
    ];
  });
}

function names(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(name).filter((value): value is string => value !== null);
}

export function normalizeDocument(raw: unknown, siteUrl: string): IssueDocument | null {
  const row = normalizeRow(raw, siteUrl);
  if (!row) return null;
  const fields = rec(rec(raw).fields);
  const { comments: list, total } = comments(fields.comment);
  return {
    ...row,
    description: cap(adfToMarkdown(fields.description)),
    reporter: person(fields.reporter),
    resolution: name(fields.resolution),
    dueDate: text(fields.duedate),
    components: names(fields.components),
    fixVersions: names(fields.fixVersions),
    parent: ref(fields.parent, siteUrl),
    subtasks: Array.isArray(fields.subtasks)
      ? fields.subtasks
          .map((entry) => ref(entry, siteUrl))
          .filter((entry): entry is IssueRef => entry !== null)
      : [],
    links: links(fields.issuelinks, siteUrl),
    comments: list,
    commentsTotal: total,
    attachments: attachments(fields.attachment),
  };
}

export function normalizeAccount(raw: unknown): { accountId: string; displayName: string } | null {
  const record = rec(raw);
  const accountId = text(record.accountId);
  if (!accountId) return null;
  return { accountId, displayName: text(record.displayName) ?? text(record.emailAddress) ?? accountId };
}
