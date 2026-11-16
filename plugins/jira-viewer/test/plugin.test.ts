import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MOCK_EMAIL, MOCK_TOKEN } from "../mock/fixtures.ts";
import { startMockJira, type MockJira } from "../mock/server.ts";
import plugin from "../server.js";

let mock: MockJira;
beforeAll(async () => {
  mock = await startMockJira();
});
afterAll(async () => {
  await mock.close();
});
beforeEach(() => mock.reset());

type Host = ReturnType<typeof createFakePluginHost>;
const hosts: Host[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose();
});

const outputs: string[] = [];
function record<T>(value: T): T {
  outputs.push(JSON.stringify(value));
  return value;
}

async function load(settings: Record<string, string> | null, sdk: Record<string, unknown> = {}) {
  const host = createFakePluginHost({
    pluginId: "jira-viewer",
    ...(settings ? { settings } : {}),
    sdk: {
      plugins: {
        list: async () => ({ plugins: [] }),
        ...(sdk.plugins as object),
      },
    } as never,
  });
  hosts.push(host);
  await plugin(host.bb);
  return host;
}

const configured = () => ({
  site: "acme.atlassian.net",
  email: MOCK_EMAIL,
  apiToken: MOCK_TOKEN,
  apiBaseUrl: mock.url,
});

describe("not configured", () => {
  it("reports needs-configuration and a setup state over RPC, CLI, tools and mentions", async () => {
    const { harness } = await load(null);
    expect(harness.inspection.needsConfigurationMessages[0]).toMatch(/site, account email and API token/);

    const status = record(await harness.behavior.callRpc("status", null)) as { state: string; missing: string[] };
    expect(status.state).toBe("not_configured");
    expect(status.missing).toEqual(["site", "email", "apiToken"]);

    const list = (await harness.behavior.callRpc("issues.list", { viewId: "my-open" })) as { error: { kind: string } };
    expect(list.error.kind).toBe("not_configured");
    expect(await harness.behavior.callRpc("issueSummary", { key: "ENG-1" })).toBeNull();

    const cli = await harness.behavior.runCli(["status"]);
    expect(cli.stdout).toMatch(/State: not configured/);

    const tool = (await harness.behavior.callAgentTool("jira_viewer_get_issue", { key: "ENG-412" })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    expect(tool.isError).toBe(true);
    expect(tool.content[0]!.text).toMatch(/not set up/);

    const provider = harness.inspection.registrations.mentionProviders[0]!;
    expect(await provider.search({ trigger: "@", query: "ENG-412", projectId: null, threadId: null })).toEqual([]);
    expect(mock.count()).toBe(0);
  });

  it("refuses plain http to a non-loopback override", async () => {
    const { harness } = await load(null);
    await expect(harness.behavior.setSettings({ apiBaseUrl: "http://jira.example.com" })).rejects.toThrow();
    await harness.behavior.setSettings({ apiBaseUrl: "http://127.0.0.1:4010" });
  });
});

describe("configured against the mock", () => {
  it("seeds the default views", async () => {
    const { harness } = await load(configured());
    const { views } = (await harness.behavior.callRpc("views.list", null)) as { views: { id: string }[] };
    expect(views.map((view) => view.id)).toEqual(["my-open", "reported", "recent"]);
  });

  it("checks the connection and reports the account", async () => {
    const { harness } = await load(configured());
    const status = (await harness.behavior.callRpc("checkConnection", null)) as {
      state: string;
      account: { displayName: string };
    };
    expect(status.state).toBe("ready");
    expect(status.account.displayName).toBe("Dev User");
  });

  it("serves a list cache-first: first load fetches, the next read is a cache hit", async () => {
    const { harness } = await load(configured());
    const first = record(
      await harness.behavior.callRpc("issues.list", { viewId: "my-open", limit: 10 }),
    ) as { issues: { key: string; statusCategory: string }[]; fetchedAt: number | null; hasMore: boolean; refreshing: boolean };
    expect(first.issues).toHaveLength(10);
    expect(first.fetchedAt).not.toBeNull();
    expect(first.hasMore).toBe(true);
    expect(first.refreshing).toBe(false);
    expect(first.issues.every((issue) => issue.statusCategory !== "done")).toBe(true);
    const requests = mock.count();

    const second = (await harness.behavior.callRpc("issues.list", { viewId: "my-open", limit: 10 })) as typeof first;
    expect(second.issues.map((issue) => issue.key)).toEqual(first.issues.map((issue) => issue.key));
    expect(mock.count()).toBe(requests);

    // The refresh invalidated the search tag and every issue it showed.
    const tags = harness.inspection.experimental_rpcInvalidations.flat().filter(Boolean) as string[];
    expect(tags.some((tag) => tag.startsWith("search:"))).toBe(true);
    expect(tags).toContain(`issue:${first.issues[0]!.key}`);
  });

  it("loads more by raising the limit", async () => {
    const { harness } = await load(configured());
    await harness.behavior.callRpc("issues.list", { jql: "project = ENG", limit: 20 });
    const more = (await harness.behavior.callRpc("issues.list", { jql: "project = ENG", limit: 200 })) as {
      issues: unknown[];
    };
    // Raising the limit refreshes in the background; force waits for it.
    await harness.behavior.callRpc("refresh", { jql: "project = ENG", limit: 200 });
    const after = (await harness.behavior.callRpc("issues.list", { jql: "project = ENG", limit: 200 })) as {
      issues: unknown[];
      hasMore: boolean;
    };
    expect(more.issues.length).toBeGreaterThanOrEqual(20);
    expect(after.issues).toHaveLength([...mock.state.issues.keys()].filter((key) => key.startsWith("ENG-")).length);
    expect(after.hasMore).toBe(false);
  });

  it("returns the issue document with converted Markdown", async () => {
    const { harness } = await load(configured());
    const result = record(await harness.behavior.callRpc("issue.get", { key: "eng-412" })) as {
      issue: {
        key: string;
        description: string;
        subtasks: { key: string }[];
        links: { label: string; issue: { key: string } }[];
        comments: { body: string }[];
        commentsTotal: number;
        url: string;
      };
    };
    expect(result.issue.key).toBe("ENG-412");
    expect(result.issue.url).toBe("https://acme.atlassian.net/browse/ENG-412");
    expect(result.issue.description).toContain("## What happens");
    expect(result.issue.subtasks.map((task) => task.key)).toEqual(["ENG-413", "ENG-414"]);
    expect(result.issue.links[0]).toMatchObject({ label: "is blocked by", issue: { key: "ENG-398" } });
    expect(result.issue.commentsTotal).toBe(3);
    expect(result.issue.comments[1]!.body).toContain("```ts");
  });

  it("answers the cross-plugin issueSummary contract exactly", async () => {
    const { harness } = await load(configured());
    const summary = await harness.behavior.callRpc(
      "issueSummary",
      { key: "ENG-412" },
      { experimental_caller: { kind: "plugin", pluginId: "task-board" } },
    );
    expect(summary).toEqual({
      key: "ENG-412",
      summary: "Session expires mid-upload",
      status: "In Progress",
      statusCategory: "in_progress",
      url: "https://acme.atlassian.net/browse/ENG-412",
    });
    expect(await harness.behavior.callRpc("issueSummary", { key: "ENG-9999" })).toBeNull();
  });

  it("drops an issue that Jira no longer has", async () => {
    const { harness } = await load(configured());
    await harness.behavior.callRpc("issue.get", { key: "ENG-420" });
    await fetch(`${mock.url}/__mock/remove`, { method: "POST", body: JSON.stringify({ key: "ENG-420" }) });
    const refreshed = (await harness.behavior.callRpc("refresh", { key: "ENG-420" })) as { error: { kind: string } };
    expect(refreshed.error.kind).toBe("not_found");
    const result = (await harness.behavior.callRpc("issue.get", { key: "ENG-420" })) as { issue: unknown };
    expect(result.issue).toBeNull();
  });

  it("maps each failure state into list results and status", async () => {
    const { harness } = await load(configured());
    const cases: [string, string][] = [
      ["unauthorized", "unauthorized"],
      ["forbidden", "forbidden"],
      ["server_error", "server"],
      ["html", "invalid_response"],
    ];
    for (const [mode, kind] of cases) {
      mock.state.mode = mode as never;
      const result = (await harness.behavior.callRpc("refresh", { jql: `project = ENG AND summary ~ "${mode}"` })) as {
        error: { kind: string } | null;
      };
      expect(result.error?.kind, mode).toBe(kind);
    }
    mock.state.mode = "unauthorized";
    await harness.behavior.callRpc("refresh", { jql: "project = OPS" });
    const status = (await harness.behavior.callRpc("status", null)) as { state: string; error: { kind: string } };
    expect(status).toMatchObject({ state: "error", error: { kind: "unauthorized" } });

    mock.state.mode = "rate_limited";
    mock.state.retryAfter = 90;
    const limited = (await harness.behavior.callRpc("refresh", { jql: "project = ENG AND key = ENG-1" })) as {
      error: { kind: string; retryAfterMs: number };
    };
    expect(limited.error).toMatchObject({ kind: "rate_limited", retryAfterMs: 90_000 });
  });

  it("reports a network failure when Jira is unreachable", async () => {
    const { harness } = await load({ ...configured(), apiBaseUrl: "http://127.0.0.1:1" });
    const result = (await harness.behavior.callRpc("refresh", { viewId: "my-open" })) as { error: { kind: string } };
    expect(result.error.kind).toBe("network");
    const cli = await harness.behavior.runCli(["search", "--view", "My open issues"]);
    expect(cli.exitCode).not.toBe(0);
    expect(cli.stderr).toMatch(/Could not reach Jira/);
  });

  it("clears the cache when the site or account changes", async () => {
    const { harness } = await load(configured());
    await harness.behavior.callRpc("issues.list", { viewId: "my-open" });
    await harness.behavior.setSettings({ email: "someone.else@example.com" });
    const stats = await harness.behavior.runCli(["cache", "stats", "--json"]);
    expect(JSON.parse(stats.stdout)).toMatchObject({ issues: 0, searches: 0 });
  });

  it("manages views and invalidates the views tag", async () => {
    const { harness } = await load(configured());
    const view = (await harness.behavior.callRpc("views.create", { name: "Ops", jql: "project = OPS" })) as { id: string };
    expect(harness.inspection.experimental_rpcInvalidations.at(-1)).toEqual(["views"]);
    await harness.behavior.callRpc("views.update", { id: view.id, name: "Operations" });
    const reordered = (await harness.behavior.callRpc("views.reorder", { ids: [view.id] })) as { views: { id: string }[] };
    expect(reordered.views[0]!.id).toBe(view.id);
    const list = (await harness.behavior.callRpc("issues.list", { viewId: view.id })) as { issues: unknown[] };
    expect(list.issues).toHaveLength(2);
    await expect(harness.behavior.callRpc("views.update", { id: "nope", name: "x" })).rejects.toMatchObject({ code: "not_found" });
    expect(await harness.behavior.callRpc("views.delete", { id: view.id })).toEqual({ removed: true });
  });

  it("links issues to threads and forgets them when the thread is deleted", async () => {
    const { harness } = await load(configured());
    await harness.behavior.callRpc("issue.get", { key: "ENG-412" });
    expect(await harness.behavior.callRpc("thread.link", { threadId: "thr_1", key: "ENG-412" })).toEqual({ linked: true });
    const linked = (await harness.behavior.callRpc("thread.issues", { threadId: "thr_1" })) as { keys: string[]; issues: unknown[] };
    expect(linked.keys).toEqual(["ENG-412"]);
    expect(linked.issues).toHaveLength(1);
    await harness.behavior.emitThreadEvent("thread.deleted", { thread: makeThreadResponse({ id: "thr_1" }) });
    expect(await harness.behavior.callRpc("thread.issues", { threadId: "thr_1" })).toEqual({ keys: [], issues: [] });
  });

  it("adds an issue to Task Board through its createTask contract", async () => {
    const calls: unknown[] = [];
    const { harness } = await load(configured(), {
      plugins: {
        list: async () => ({ plugins: [{ id: "task-board", status: "running" }] }),
        callRpc: async (args: unknown) => {
          calls.push(args);
          return { id: "task_9" };
        },
      },
    });
    const status = (await harness.behavior.callRpc("status", null)) as { integrations: { taskBoard: boolean } };
    expect(status.integrations.taskBoard).toBe(true);
    const created = await harness.behavior.callRpc("addToTaskBoard", { key: "ENG-412", projectId: "proj_1" });
    expect(created).toEqual({ id: "task_9", route: "/plugins/task-board/board/task/task_9" });
    expect(calls[0]).toMatchObject({
      pluginId: "task-board",
      method: "createTask",
      input: {
        title: "Session expires mid-upload",
        projectId: "proj_1",
        externalRef: { kind: "jira", key: "ENG-412", url: "https://acme.atlassian.net/browse/ENG-412" },
      },
    });
    expect((calls[0] as { input: { body: string } }).input.body).toContain("## Description");
  });

  it("runs the CLI commands", async () => {
    const { harness } = await load(configured());
    const search = record(await harness.behavior.runCli(["search", "project = OPS"]));
    expect(search.exitCode).toBe(0);
    expect(search.stdout).toMatch(/OPS-7\s+To Do/);

    const paged = await harness.behavior.runCli(["search", "--query", "Details", "--limit", "5"]);
    expect(paged.stdout).toMatch(/--page-token '/);

    const issue = record(await harness.behavior.runCli(["issue", "ENG-412"]));
    expect(issue.stdout).toMatch(/^# ENG-412: Session expires mid-upload/);
    expect(issue.stdout).toContain("## Comments (3)");

    const bad = await harness.behavior.runCli(["issue", "nope", "--json"]);
    expect(bad.exitCode).not.toBe(0);
    expect(JSON.parse(bad.stdout)).toMatchObject({ ok: false, error: { code: "invalid_key" } });

    const jql = await harness.behavior.runCli(["search", "bogus = 1", "--json"]);
    expect(JSON.parse(jql.stdout)).toMatchObject({ ok: false, error: { code: "bad_request" } });

    const views = await harness.behavior.runCli(["views", "list"]);
    expect(views.stdout).toContain("My open issues");
    const added = await harness.behavior.runCli(["views", "add", "Ops", "--jql", "project = OPS"]);
    expect(added.stdout).toMatch(/Saved view Ops/);
    expect((await harness.behavior.runCli(["views", "remove", "Ops"])).exitCode).toBe(0);
  });

  it("runs the agent tools with bounded output", async () => {
    const { harness } = await load(configured());
    const search = record(await harness.behavior.callAgentTool("jira_viewer_search", { query: "Details", limit: 50 })) as string;
    expect(search.split("\n").length).toBeLessThan(60);
    expect(search).toMatch(/nextPageToken: /);

    const issue = record(await harness.behavior.callAgentTool("jira_viewer_get_issue", { key: "ENG-412" })) as string;
    expect(issue).toContain("## Subtasks (1 of 2 done)");
    expect(issue.length).toBeLessThan(30_000);

    const both = await harness.behavior
      .callAgentTool("jira_viewer_search", { jql: "x", query: "y" })
      .then((value) => JSON.stringify(value), (error: Error) => error.message);
    expect(both).toMatch(/exactly one/);
  });

  it("caps a huge description in tool output", async () => {
    const { harness } = await load(configured());
    const huge = { type: "doc", content: Array.from({ length: 2000 }, (_, i) => ({ type: "paragraph", content: [{ type: "text", text: `Line ${i} ${"x".repeat(40)}` }] })) };
    mock.state.issues.get("ENG-405")!.fields.description = huge;
    const issue = (await harness.behavior.callAgentTool("jira_viewer_get_issue", { key: "ENG-405" })) as string;
    expect(issue).toMatch(/Description truncated at 8000 characters/);
    expect(issue.length).toBeLessThan(12_000);
  });

  it("offers issues as mentions and resolves one to agent context", async () => {
    const { harness } = await load(configured());
    const provider = harness.inspection.registrations.mentionProviders[0]!;
    expect(provider.triggers).toEqual(["@"]);
    const byKey = await provider.search({ trigger: "@", query: "ENG-412", projectId: null, threadId: null });
    expect(byKey[0]).toMatchObject({ id: "ENG-412", title: "ENG-412 Session expires mid-upload" });
    const byWords = await provider.search({ trigger: "@", query: "retry queue", projectId: null, threadId: null });
    expect(byWords.map((item) => item.id)).toContain("ENG-398");
    expect(await provider.search({ trigger: "@", query: "e", projectId: null, threadId: null })).toEqual([]);
    const resolved = record(await provider.resolve("ENG-412"));
    expect(resolved.context).toMatch(/The user mentioned Jira issue ENG-412/);
    expect(resolved.context).toContain("## Description");
  });

  it("never leaks the token into outputs or logs", async () => {
    const { harness } = await load(configured());
    record(await harness.behavior.runCli(["status", "--json"]));
    record(await harness.behavior.callRpc("status", null));
    mock.state.mode = "unauthorized";
    record(await harness.behavior.runCli(["check"]));
    const logs = JSON.stringify(harness.inspection.logEntries);
    for (const text of [...outputs, logs]) {
      expect(text).not.toContain(MOCK_TOKEN);
      expect(text).not.toContain(Buffer.from(`${MOCK_EMAIL}:${MOCK_TOKEN}`).toString("base64"));
    }
  });
});
