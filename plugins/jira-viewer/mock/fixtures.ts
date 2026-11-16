// Fixture issues shaped like Jira Cloud REST v3 responses (fields as
// `GET /rest/api/3/issue/{key}` and `POST /rest/api/3/search/jql` return
// them). Used by the mock server and the tests.

export const MOCK_EMAIL = "dev@example.com";
export const MOCK_TOKEN = "mock-token-not-a-secret";

type Json = Record<string, unknown>;

export const users = {
  me: {
    accountId: "712020:mock-dev-0001",
    accountType: "atlassian",
    emailAddress: MOCK_EMAIL,
    displayName: "Dev User",
    active: true,
    timeZone: "UTC",
  },
  ana: { accountId: "712020:mock-ana-0002", accountType: "atlassian", displayName: "Ana Ruiz", active: true },
  leo: { accountId: "712020:mock-leo-0003", accountType: "atlassian", displayName: "Leo Park", active: true },
} as const;

const categories = {
  todo: { id: 2, key: "new", colorName: "blue-gray", name: "To Do" },
  progress: { id: 4, key: "indeterminate", colorName: "yellow", name: "In Progress" },
  done: { id: 3, key: "done", colorName: "green", name: "Done" },
};

export const statuses = {
  todo: { id: "10000", name: "To Do", statusCategory: categories.todo },
  progress: { id: "3", name: "In Progress", statusCategory: categories.progress },
  review: { id: "10002", name: "In Review", statusCategory: categories.progress },
  done: { id: "10001", name: "Done", statusCategory: categories.done },
} as const;

const types = {
  bug: { id: "10004", name: "Bug", subtask: false, hierarchyLevel: 0 },
  task: { id: "10002", name: "Task", subtask: false, hierarchyLevel: 0 },
  story: { id: "10001", name: "Story", subtask: false, hierarchyLevel: 0 },
  subtask: { id: "10003", name: "Subtask", subtask: true, hierarchyLevel: -1 },
};

const priorities = {
  high: { id: "2", name: "High" },
  medium: { id: "3", name: "Medium" },
  low: { id: "4", name: "Low" },
};

const projects = {
  ENG: { id: "10000", key: "ENG", name: "Engineering", projectTypeKey: "software" },
  OPS: { id: "10001", key: "OPS", name: "Operations", projectTypeKey: "service_desk" },
};

const p = (...content: Json[]) => ({ type: "paragraph", content });
const t = (text: string, marks?: Json[]) => (marks ? { type: "text", text, marks } : { type: "text", text });
const doc = (...content: Json[]) => ({ type: "doc", version: 1, content });

/** A deliberately rich description: every node type the converter handles. */
export const richDescription = doc(
  { type: "heading", attrs: { level: 2 }, content: [t("What happens")] },
  p(
    t("Uploads over "),
    t("200 MB", [{ type: "strong" }]),
    t(" fail when the session token expires mid-transfer. Reported by "),
    { type: "mention", attrs: { id: users.ana.accountId, text: "@Ana Ruiz", accessLevel: "" } },
    t(" on "),
    { type: "date", attrs: { timestamp: "1762300800000" } },
    t(". See "),
    t("the runbook", [{ type: "link", attrs: { href: "https://example.com/runbook" } }]),
    t(" and "),
    { type: "inlineCard", attrs: { url: "https://example.atlassian.net/browse/ENG-398" } },
    t("."),
  ),
  {
    type: "panel",
    attrs: { panelType: "warning" },
    content: [p(t("Customers on the "), t("Pro", [{ type: "em" }]), t(" plan are affected first."))],
  },
  { type: "heading", attrs: { level: 3 }, content: [t("Steps")] },
  {
    type: "orderedList",
    attrs: { order: 1 },
    content: [
      { type: "listItem", content: [p(t("Start an upload of a 500 MB file"))] },
      {
        type: "listItem",
        content: [
          p(t("Wait for the token to expire (default "), t("ttl = 3600", [{ type: "code" }]), t(")")),
          {
            type: "bulletList",
            content: [
              { type: "listItem", content: [p(t("Shorten it with "), t("SESSION_TTL=60", [{ type: "code" }]))] },
              { type: "listItem", content: [p(t("or wait an hour"))] },
            ],
          },
        ],
      },
      { type: "listItem", content: [p(t("Watch the upload fail with "), { type: "status", attrs: { text: "401", color: "red" } })] },
    ],
  },
  {
    type: "codeBlock",
    attrs: { language: "ts" },
    content: [t("if (!token) return null;\nrefresh(token);")],
  },
  {
    type: "table",
    attrs: { isNumberColumnEnabled: false, layout: "default" },
    content: [
      {
        type: "tableRow",
        content: [
          { type: "tableHeader", attrs: {}, content: [p(t("Size"))] },
          { type: "tableHeader", attrs: {}, content: [p(t("Result"))] },
        ],
      },
      {
        type: "tableRow",
        content: [
          { type: "tableCell", attrs: {}, content: [p(t("100 MB"))] },
          { type: "tableCell", attrs: {}, content: [p(t("ok | fast"))] },
        ],
      },
      {
        type: "tableRow",
        content: [
          { type: "tableCell", attrs: {}, content: [p(t("500 MB"))] },
          { type: "tableCell", attrs: {}, content: [p(t("fails", [{ type: "strong" }]))] },
        ],
      },
    ],
  },
  {
    type: "taskList",
    attrs: { localId: "tl-1" },
    content: [
      { type: "taskItem", attrs: { localId: "t1", state: "DONE" }, content: [t("Reproduce")] },
      { type: "taskItem", attrs: { localId: "t2", state: "TODO" }, content: [t("Fix refresh")] },
    ],
  },
  {
    type: "mediaSingle",
    attrs: { layout: "center" },
    content: [{ type: "media", attrs: { id: "a1b2c3", type: "file", collection: "", alt: "upload-error.png", width: 800, height: 400 } }],
  },
  { type: "expand", attrs: { title: "Logs" }, content: [{ type: "codeBlock", attrs: {}, content: [t("ERR token_expired at 12:00:01")] }] },
  { type: "rule" },
  { type: "someFutureNode", content: [p(t("Unknown nodes keep their text."))] },
);

let clock = Date.parse("2026-11-10T09:00:00.000Z");
function nextTime(): string {
  clock += 37 * 60_000;
  return new Date(clock).toISOString().replace("Z", "+0000");
}

interface Seed {
  key: string;
  summary: string;
  status: keyof typeof statuses;
  type?: keyof typeof types;
  priority?: keyof typeof priorities;
  assignee?: keyof typeof users | null;
  reporter?: keyof typeof users;
  labels?: string[];
  description?: Json | null;
  parent?: string;
  comments?: { author: keyof typeof users; body: Json }[];
}

const seeds: Seed[] = [
  {
    key: "ENG-412",
    summary: "Session expires mid-upload",
    status: "progress",
    type: "bug",
    priority: "high",
    assignee: "me",
    reporter: "ana",
    labels: ["uploads", "auth"],
    description: richDescription,
    comments: [
      { author: "ana", body: doc(p(t("Seeing this on staging too."))) },
      {
        author: "leo",
        body: doc(
          p(t("Root cause is in "), t("session.ts", [{ type: "code" }]), t(":")),
          { type: "codeBlock", attrs: { language: "ts" }, content: [t("const ttl = 60 * 60;")] },
        ),
      },
      { author: "me", body: doc(p(t("Taking this. "), { type: "emoji", attrs: { shortName: ":thumbsup:", text: "👍" } })) },
    ],
  },
  { key: "ENG-413", summary: "Refresh token before upload chunk", status: "todo", type: "subtask", assignee: "me", parent: "ENG-412" },
  { key: "ENG-414", summary: "Add upload expiry test", status: "done", type: "subtask", assignee: "leo", parent: "ENG-412" },
  { key: "ENG-398", summary: "Retry queue drops jobs", status: "progress", type: "bug", priority: "high", assignee: "leo", reporter: "me", labels: ["queue"] },
  { key: "ENG-420", summary: "Export fails over 10k rows", status: "todo", type: "bug", priority: "medium", assignee: null, reporter: "me", labels: ["exports", "finance"] },
  { key: "ENG-401", summary: "Dark mode for settings", status: "review", type: "story", priority: "low", assignee: "me", reporter: "ana" },
  { key: "ENG-402", summary: "Rate limit the search API", status: "todo", type: "task", priority: "medium", assignee: "me", reporter: "me" },
  { key: "ENG-403", summary: "Flaky login test on CI", status: "todo", type: "bug", priority: "high", assignee: "me", reporter: "leo" },
  { key: "ENG-404", summary: "Migrate cron jobs to the scheduler", status: "done", type: "task", assignee: "me", reporter: "me" },
  { key: "ENG-405", summary: "Document the release process", status: "todo", type: "task", priority: "low", assignee: "ana", reporter: "me", description: null },
  { key: "OPS-7", summary: "Rotate staging certificates", status: "todo", type: "task", priority: "high", assignee: "me", reporter: "ana" },
  { key: "OPS-8", summary: "Disk alert on build runner", status: "done", type: "task", assignee: "leo", reporter: "me" },
];

const longDescription = doc(
  p(t("Exports over 10,000 rows time out after 30 s and the user gets an empty CSV. This blocks finance at month end, so it needs a fix before the 1st.")),
  { type: "heading", attrs: { level: 2 }, content: [t("Background")] },
  p(
    t("The export job builds the whole file in memory before streaming it. For large workspaces the query alone takes 18 s, and serialising 40 columns doubles that. We added a 30 s gateway timeout last quarter, which is what users now hit. Nothing in the logs says the export failed: the worker finishes later and throws the file away because the request is gone."),
  ),
  p(
    t("Two customers raised it this week. Both have more than 50,000 rows in the "),
    t("orders", [{ type: "code" }]),
    t(" table and export with every column selected."),
  ),
  { type: "heading", attrs: { level: 2 }, content: [t("Proposal")] },
  {
    type: "orderedList",
    attrs: { order: 1 },
    content: [
      { type: "listItem", content: [p(t("Stream rows from a server-side cursor instead of loading them all."))] },
      { type: "listItem", content: [p(t("Move exports over 5,000 rows to a background job and email a link when it is ready."))] },
      { type: "listItem", content: [p(t("Show progress in the export dialog, with a way to cancel."))] },
    ],
  },
  { type: "codeBlock", attrs: { language: "sql" }, content: [t("DECLARE export_cursor CURSOR FOR\n  SELECT id, created_at, total, status\n  FROM orders\n  WHERE workspace_id = $1\n  ORDER BY created_at;")] },
  { type: "heading", attrs: { level: 2 }, content: [t("Measurements")] },
  {
    type: "table",
    attrs: {},
    content: [
      { type: "tableRow", content: ["Rows", "Query", "Serialise", "Total"].map((h) => ({ type: "tableHeader", attrs: {}, content: [p(t(h))] })) },
      ...[
        ["5,000", "1.2 s", "0.8 s", "2.0 s"],
        ["10,000", "3.9 s", "2.1 s", "6.0 s"],
        ["50,000", "18.4 s", "16.9 s", "35.3 s (timeout)"],
      ].map((row) => ({ type: "tableRow", content: row.map((c) => ({ type: "tableCell", attrs: {}, content: [p(t(c))] })) })),
    ],
  },
  { type: "panel", attrs: { panelType: "info" }, content: [p(t("Exports under 5,000 rows keep the current path; nothing changes for most users."))] },
  { type: "heading", attrs: { level: 2 }, content: [t("Out of scope")] },
  { type: "bulletList", content: [
    { type: "listItem", content: [p(t("Excel output. CSV only for now."))] },
    { type: "listItem", content: [p(t("Scheduled exports."))] },
  ] },
  p(t("Done when a 100,000-row export completes and the file opens with every row.")),
);

const discussion: { author: keyof typeof users; body: Json }[] = [
  ["ana", "I can reproduce with the staging copy of the Acme workspace."],
  ["leo", "Retry queue drops the job when the worker restarts mid-batch."],
  ["me", "Is it every restart or only on deploys?"],
  ["leo", "Every restart. The ack happens before the job is durable."],
  ["ana", "That matches what support saw on Tuesday."],
  ["me", "Moving the ack after the write should fix it."],
  ["leo", "Agreed. Also need a test that kills the worker between steps."],
  ["ana", "Added a repro script to the ticket."],
  ["me", "Draft PR is up."],
  ["leo", "Left two comments on the PR, mostly naming."],
  ["ana", "Verified on staging, no drops in 200 runs."],
  ["me", "Merging after the deploy freeze lifts."],
].map(([author, text]) => ({ author: author as keyof typeof users, body: doc(p(t(text as string))) }));

seeds.push(
  { key: "ENG-430", summary: "Audit log misses bulk edits made through the API when the caller uses a service account", status: "todo", type: "bug", priority: "medium", assignee: null, reporter: "ana", labels: ["audit", "api"] },
  { key: "ENG-431", summary: "Add retry budget to webhook sender", status: "progress", type: "story", priority: "low", assignee: null, reporter: "me", labels: ["webhooks"] },
  { key: "ENG-440", summary: "Billing page redesign", status: "progress", type: "story", priority: "high", assignee: "me", reporter: "ana", labels: ["billing", "design"] },
  { key: "ENG-441", summary: "New plan picker", status: "done", type: "subtask", assignee: "ana", parent: "ENG-440" },
  { key: "ENG-442", summary: "Invoice history table", status: "progress", type: "subtask", assignee: "me", parent: "ENG-440" },
  { key: "ENG-443", summary: "Payment method form", status: "todo", type: "subtask", assignee: null, parent: "ENG-440" },
  { key: "ENG-444", summary: "Empty and error states", status: "todo", type: "subtask", assignee: "leo", parent: "ENG-440" },
  { key: "ENG-445", summary: "Copy review", status: "done", type: "subtask", assignee: "ana", parent: "ENG-440" },
);

// Enough extra issues to exercise pagination (> 100 for the list cap),
// with varied titles and owners so lists read like a real backlog.
const areas = ["Search", "Billing", "Uploads", "Notifications", "Admin console", "Mobile app", "API", "Onboarding", "Reports", "Auth"];
const problems = [
  "slow first load on large workspaces",
  "copy is unclear in the empty state",
  "loses the draft after a reload",
  "keyboard focus jumps to the top",
  "date filter ignores the time zone",
  "retries forever on a 400",
  "missing loading state on refresh",
  "wrong count after deleting an item",
  "export button stays disabled",
  "dark mode contrast too low on badges",
  "pagination skips the last page",
];
const owners = ["ana", "leo", "ana", "leo", "me"] as const;
for (let n = 0; n < 110; n++) {
  seeds.push({
    key: `ENG-${500 + n}`,
    summary: `${areas[(n * 3) % areas.length]}: ${problems[(n * 7) % problems.length]}`,
    status: (["todo", "progress", "review", "done"] as const)[n % 4]!,
    type: n % 3 === 0 ? "bug" : "task",
    priority: (["low", "medium", "high"] as const)[n % 3]!,
    assignee: n % 9 === 4 ? null : owners[(n * 2 + 1) % owners.length]!,
    reporter: "leo",
    labels: n % 4 === 0 ? [areas[(n * 3) % areas.length]!.toLowerCase().replace(/\s+/g, "-")] : [],
  });
}

function comment(id: number, author: keyof typeof users, body: Json, created: string) {
  return {
    id: String(10_000 + id),
    author: users[author],
    body,
    updateAuthor: users[author],
    created,
    updated: created,
    jsdPublic: true,
  };
}

export type FixtureIssue = { id: string; key: string; self: string; expand: string; fields: Json };

/** Build the fixture set fresh (tests mutate it). */
export function buildIssues(baseUrl: string): Map<string, FixtureIssue> {
  clock = Date.parse("2026-11-10T09:00:00.000Z");
  const issues = new Map<string, FixtureIssue>();
  let id = 20_000;
  let commentId = 0;
  for (const seed of seeds) {
    const created = nextTime();
    const projectKey = seed.key.split("-")[0] as keyof typeof projects;
    const fields: Json = {
      summary: seed.summary,
      status: { self: `${baseUrl}/rest/api/3/status/${statuses[seed.status].id}`, ...statuses[seed.status] },
      issuetype: types[seed.type ?? "task"],
      priority: seed.priority ? priorities[seed.priority] : null,
      assignee: seed.assignee ? users[seed.assignee] : null,
      reporter: users[seed.reporter ?? "me"],
      project: projects[projectKey],
      labels: seed.labels ?? [],
      created,
      updated: nextTime(),
      description:
        seed.description === undefined
          ? doc(p(t(`${seed.summary}. Details in the linked thread.`)))
          : seed.description,
      resolution: seed.status === "done" ? { id: "10000", name: "Done" } : null,
      duedate: seed.key === "ENG-412" ? "2026-11-20" : null,
      components: seed.key.startsWith("ENG-41") ? [{ id: "1", name: "Uploads" }] : [],
      fixVersions: seed.key === "ENG-412" ? [{ id: "1", name: "2.4.0" }] : [],
      subtasks: [],
      issuelinks: [],
      attachment:
        seed.key === "ENG-412"
          ? [{ id: "30001", filename: "upload-error.png", mimeType: "image/png", size: 48213, created }]
          : [],
      comment: {
        comments: (seed.comments ?? []).map((entry) => comment(commentId++, entry.author, entry.body, nextTime())),
        maxResults: (seed.comments ?? []).length,
        total: (seed.comments ?? []).length,
        startAt: 0,
      },
    };
    if (seed.key === "ENG-420") fields.description = longDescription;
    if (seed.key === "ENG-398") {
      const list = discussion.map((entry) => comment(commentId++, entry.author, entry.body, nextTime()));
      fields.comment = { comments: list, maxResults: list.length, total: list.length, startAt: 0 };
    }
    if (seed.parent) fields.parent = { key: seed.parent };
    const issueId = String(id++);
    issues.set(seed.key, {
      id: issueId,
      key: seed.key,
      self: `${baseUrl}/rest/api/3/issue/${issueId}`,
      expand: "renderedFields,names,schema,operations,editmeta,changelog,versionedRepresentations",
      fields,
    });
  }
  // Wire parents, subtasks and links like Jira does.
  const brief = (key: string) => {
    const issue = issues.get(key)!;
    const fields = issue.fields;
    return {
      id: issue.id,
      key,
      self: issue.self,
      fields: {
        summary: fields.summary,
        status: fields.status,
        priority: fields.priority,
        issuetype: fields.issuetype,
      },
    };
  };
  for (const issue of issues.values()) {
    const parent = issue.fields.parent as { key: string } | undefined;
    if (parent) {
      issue.fields.parent = brief(parent.key);
      (issues.get(parent.key)!.fields.subtasks as unknown[]).push(brief(issue.key));
    }
  }
  const link = (from: string, to: string) => {
    (issues.get(from)!.fields.issuelinks as unknown[]).push({
      id: "40001",
      type: { id: "10000", name: "Blocks", inward: "is blocked by", outward: "blocks" },
      outwardIssue: brief(to),
    });
    (issues.get(to)!.fields.issuelinks as unknown[]).push({
      id: "40001",
      type: { id: "10000", name: "Blocks", inward: "is blocked by", outward: "blocks" },
      inwardIssue: brief(from),
    });
  };
  link("ENG-398", "ENG-412");
  return issues;
}
