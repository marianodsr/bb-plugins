import type { HandoffThread, HandoffTarget, JsonObject, TintHue } from "../kit";

export const CURRENT_THREAD_ID = "thr_demo_current";

export const fakeThreads: HandoffThread[] = [
  { id: CURRENT_THREAD_ID, title: "Review auth session changes", status: "idle", projectId: "p1", projectName: "bb-plugins", updatedAt: 9 },
  { id: "thr_demo_1", title: "Fix session refresh race", status: "running", projectId: "p1", projectName: "bb-plugins", updatedAt: 8 },
  { id: "thr_demo_2", title: "Jira sync: paginate search results", status: "waiting", projectId: "p1", projectName: "bb-plugins", updatedAt: 7 },
  { id: "thr_demo_3", title: "Editor comments rail", status: "idle", projectId: "p1", projectName: "bb-plugins", updatedAt: 6 },
  { id: "thr_demo_4", title: "Flaky login test on CI", status: "failed", projectId: "p2", projectName: "web-app", updatedAt: 5 },
  { id: "thr_demo_5", title: "Upgrade CodeMirror merge view", status: "idle", projectId: "p1", projectName: "bb-plugins", updatedAt: 4 },
  { id: "thr_demo_6", title: "Board drag and keyboard move", status: "running", projectId: "p1", projectName: "bb-plugins", updatedAt: 3 },
];

export type Severity = "issue" | "question" | "nit";
export const severityHue: Record<Severity, TintHue> = { issue: "red", question: "blue", nit: "gray" };

export interface ReviewComment {
  id: string;
  path: string;
  start: number;
  end: number;
  snippet: string;
  body: string;
  severity: Severity;
}

export const comments: ReviewComment[] = [
  {
    id: "c1",
    path: "src/auth/session.ts",
    start: 42,
    end: 43,
    snippet: "if (!token) return null;",
    body: "Why null here? The caller retries on null and can loop forever when the refresh token is gone.",
    severity: "issue",
  },
  {
    id: "c2",
    path: "src/auth/session.ts",
    start: 58,
    end: 58,
    snippet: "const ttl = 60 * 60;",
    body: "Read this from config so tests can shorten it.",
    severity: "nit",
  },
  {
    id: "c3",
    path: "src/api/client.ts",
    start: 117,
    end: 121,
    snippet: "await refresh(token);",
    body: "Two requests can both see an expired token and refresh twice. Should this share one in-flight refresh?",
    severity: "question",
  },
];

export interface Task {
  id: string;
  title: string;
  labels: string[];
  lane: string;
}

export const tasks: Task[] = [
  { id: "t1", title: "Fix flaky login test", labels: ["auth", "ci"], lane: "To do" },
  { id: "t2", title: "Comments in the editor margin", labels: ["editor"], lane: "In progress" },
  { id: "t3", title: "Paginate Jira search", labels: ["jira", "api"], lane: "Review" },
];

export type StatusCategory = "new" | "indeterminate" | "done";
export const categoryHue: Record<StatusCategory, TintHue> = { new: "gray", indeterminate: "blue", done: "green" };

export interface Issue {
  key: string;
  summary: string;
  status: string;
  category: StatusCategory;
  assignee: string;
}

export const issues: Issue[] = [
  { key: "ENG-412", summary: "Session expires mid-upload", status: "In progress", category: "indeterminate", assignee: "Ana Ruiz" },
  { key: "ENG-398", summary: "Retry queue drops jobs after restart", status: "In progress", category: "indeterminate", assignee: "Leo Park" },
  { key: "ENG-420", summary: "Export fails over 10k rows", status: "To do", category: "new", assignee: "Unassigned" },
];

const where = (target: HandoffTarget) =>
  target.kind === "new" ? "Start by reading the code involved." : "Pick this up after your current step.";

export function reviewPrompt(items: readonly ReviewComment[], target: HandoffTarget): string {
  const lines = items.map(
    (c) =>
      `- ${c.path}:${c.start === c.end ? c.start : `${c.start}-${c.end}`} (${c.severity})\n  \`${c.snippet}\`\n  ${c.body}`,
  );
  return `Please address these review comments. ${where(target)}\n\n${lines.join("\n\n")}\n\nReply to each comment with what you changed, using the review_reply tool.`;
}

export function taskPrompt(items: readonly Task[], target: HandoffTarget): string {
  const lines = items.map((t) => `- ${t.title} [${t.labels.join(", ")}] (task ${t.id})`);
  return `Start work on ${items.length === 1 ? "this task" : "these tasks"}. ${where(target)}\n\n${lines.join("\n")}\n\nMove each task to Review with tasks_move when it is done.`;
}

export function issuePrompt(items: readonly Issue[], target: HandoffTarget): string {
  const lines = items.map((i) => `- ${i.key}: ${i.summary} (${i.status}, ${i.assignee})`);
  return `Investigate ${items.length === 1 ? "this Jira issue" : "these Jira issues"}. ${where(target)}\n\n${lines.join("\n")}\n\nUse jira_viewer_get_issue for the full description and comments.`;
}

export const metadataFor = {
  review: (items: readonly ReviewComment[]): JsonObject => ({ reviewCommentIds: items.map((c) => c.id) }),
  task: (items: readonly Task[]): JsonObject => ({ taskId: items[0]?.id ?? null }),
  issue: (items: readonly Issue[]): JsonObject => ({ jiraKeys: items.map((i) => i.key) }),
};
