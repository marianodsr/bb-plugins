import Database from "better-sqlite3";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MOCK_EMAIL, MOCK_TOKEN } from "../mock/fixtures.ts";
import { startMockJira, type MockJira } from "../mock/server.ts";
import { resolveConfig } from "../src/config.js";
import { JiraViewerService } from "../src/service.js";
import { MIGRATIONS, Store } from "../src/store.js";

let mock: MockJira;
beforeAll(async () => {
  mock = await startMockJira();
});
afterAll(async () => {
  await mock.close();
});
beforeEach(() => mock.reset());

function setup(limits = { maxIssues: 2000, maxSearches: 200 }) {
  const db = new Database(":memory:");
  for (const statement of MIGRATIONS) db.exec(statement);
  const store = new Store(db, limits);
  store.seedViews(0);
  let now = 1_000_000;
  const invalidations: string[][] = [];
  const service = new JiraViewerService({
    store,
    readConfig: async () =>
      resolveConfig({ site: "acme.atlassian.net", email: MOCK_EMAIL, apiToken: MOCK_TOKEN, apiBaseUrl: mock.url }),
    invalidate: (tags) => invalidations.push(tags),
    invalidateAll: () => invalidations.push(["*"]),
    log: { debug() {}, info() {}, warn() {}, error() {} },
    lifetime: new AbortController().signal,
    now: () => now,
  });
  return { service, store, invalidations, advance: (ms: number) => (now += ms) };
}

const source = { viewId: null, jql: "project = OPS ORDER BY updated DESC" };

describe("stale-while-revalidate", () => {
  it("serves the cache at once, refreshes behind it, and invalidates what changed", async () => {
    const { service, invalidations, advance } = setup();
    const first = await service.list(source, { limit: 50 });
    expect(first.issues.map((issue) => issue.key).sort()).toEqual(["OPS-7", "OPS-8"]);
    expect(mock.count()).toBe(1);

    // Fresh: a cache hit with no request.
    advance(30_000);
    const hit = await service.list(source, { limit: 50 });
    expect(hit.stale).toBe(false);
    expect(mock.count()).toBe(1);

    // Jira changes; the cache goes stale.
    await fetch(`${mock.url}/__mock/touch`, {
      method: "POST",
      body: JSON.stringify({ key: "OPS-7", summary: "Rotate staging and prod certificates" }),
    });
    advance(61_000);
    invalidations.length = 0;
    const stale = await service.list(source, { limit: 50 });
    // Old data comes back immediately, with a refresh in flight.
    expect(stale.issues.find((issue) => issue.key === "OPS-7")!.summary).toBe("Rotate staging certificates");
    expect(stale.stale).toBe(true);
    expect(stale.refreshing).toBe(true);

    // A concurrent read shares the same request.
    await service.list(source, { limit: 50 });
    await service.refreshList(source.jql, 50);
    expect(mock.count()).toBe(2);

    // The refresh invalidated the search and only the issue that changed.
    const tags = invalidations.flat();
    expect(tags.filter((tag) => tag.startsWith("search:"))).toHaveLength(1);
    expect(tags).toContain("issue:OPS-7");
    expect(tags).not.toContain("issue:OPS-8");

    const after = await service.list(source, { limit: 50 });
    expect(after.issues.find((issue) => issue.key === "OPS-7")!.summary).toBe("Rotate staging and prod certificates");
    expect(after.refreshing).toBe(false);
    expect(after.stale).toBe(false);
  });

  it("keeps cached data and records the error when a refresh fails", async () => {
    const { service, advance } = setup();
    await service.list(source, { limit: 50 });
    mock.state.mode = "server_error";
    advance(61_000);
    await service.list(source, { limit: 50 });
    await service.refreshList(source.jql, 50);
    const result = await service.list(source, { limit: 50 });
    expect(result.issues).toHaveLength(2);
    expect(result.error?.kind).toBe("server");
    mock.state.mode = "ok";
    advance(61_000);
    await service.list(source, { limit: 50 });
    await service.refreshList(source.jql, 50);
    expect((await service.list(source, { limit: 50 })).error).toBeNull();
  });

  it("serves a cached document when Jira is down", async () => {
    const { service } = setup();
    await service.fetchIssue("ENG-412");
    mock.state.mode = "server_error";
    const read = await service.issueForReading("ENG-412");
    expect(read.fromCache).toBe(true);
    expect(read.failure?.kind).toBe("server");
    expect(read.doc.key).toBe("ENG-412");
  });
});

describe("cache bounds", () => {
  it("evicts the least recently used issues and searches", async () => {
    const { service, store, advance } = setup({ maxIssues: 30, maxSearches: 2 });
    await service.list({ viewId: null, jql: "project = ENG" }, { limit: 100 });
    advance(31_000); // past the prune throttle
    await service.list({ viewId: null, jql: "project = OPS" }, { limit: 10 });
    advance(31_000);
    await service.list({ viewId: null, jql: "assignee = currentUser()" }, { limit: 10 });
    const stats = store.stats();
    expect(stats.issues).toBeLessThanOrEqual(30);
    expect(stats.searches).toBeLessThanOrEqual(2);
  });
});

describe("failure backoff", () => {
  it("does not refetch a failing query on every read", async () => {
    const { service, advance } = setup();
    const bad = { viewId: null, jql: "bogus = 1" };
    const first = await service.list(bad, { limit: 50 });
    expect(first.error?.kind).toBe("bad_request");
    const after = mock.count();
    for (let i = 0; i < 5; i++) await service.list(bad, { limit: 50 });
    expect(mock.count()).toBe(after);
    advance(61_000);
    await service.list(bad, { limit: 50 });
    expect(mock.count()).toBe(after + 1);
  });

  it("does not refetch a missing issue on every read", async () => {
    const { service } = setup();
    expect((await service.issue("ENG-9999")).error?.kind).toBe("not_found");
    const after = mock.count();
    for (let i = 0; i < 5; i++) await service.issue("ENG-9999");
    expect(mock.count()).toBe(after);
    await service.issue("ENG-9999", { force: true });
    expect(mock.count()).toBe(after + 1);
  });
});
