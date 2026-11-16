import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MOCK_EMAIL, MOCK_TOKEN } from "../mock/fixtures.ts";
import { startMockJira, type MockJira } from "../mock/server.ts";
import { JiraClient, JiraError, RateGate, parseRetryAfter } from "../src/jira/client.js";
import { ROW_FIELDS } from "../src/jira/normalize.js";
import type { FailureKind } from "../src/schemas.js";

let mock: MockJira;

beforeAll(async () => {
  mock = await startMockJira();
});
afterAll(async () => {
  await mock.close();
});
beforeEach(() => mock.reset());

function client(overrides: Partial<{ token: string; timeoutMs: number; gate: RateGate; base: string }> = {}) {
  return new JiraClient(
    { apiBaseUrl: overrides.base ?? mock.url, email: MOCK_EMAIL, token: overrides.token ?? MOCK_TOKEN },
    { timeoutMs: overrides.timeoutMs ?? 2_000, ...(overrides.gate ? { gate: overrides.gate } : {}) },
  );
}

async function failureOf(promise: Promise<unknown>): Promise<{ kind: FailureKind; message: string; retryAfterMs: number | null }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof JiraError) return error.failure;
    throw error;
  }
  throw new Error("expected a failure");
}

describe("JiraClient", () => {
  it("reads the signed-in account", async () => {
    const me = (await client().myself()) as { displayName: string };
    expect(me.displayName).toBe("Dev User");
  });

  it("follows page tokens across pages up to the limit", async () => {
    const result = await client().search({ jql: "project = ENG ORDER BY updated DESC", fields: ROW_FIELDS, limit: 110 });
    expect(result.issues).toHaveLength(110);
    expect(result.hasMore).toBe(true);
    expect(result.nextPageToken).toBeTruthy();
    // 100 + 10: Jira's 100-per-page cap is respected.
    expect(mock.count("/rest/api/3/search/jql")).toBe(2);

    const rest = await client().search({
      jql: "project = ENG ORDER BY updated DESC",
      fields: ROW_FIELDS,
      limit: 100,
      pageToken: result.nextPageToken,
    });
    expect(rest.hasMore).toBe(false);
    const eng = [...mock.state.issues.keys()].filter((key) => key.startsWith("ENG-")).length;
    expect(result.issues.length + rest.issues.length).toBe(eng);
  });

  it("stops when Jira repeats a page token", async () => {
    let calls = 0;
    const looping = new JiraClient(
      { apiBaseUrl: "https://loop.example", email: "a@b.c", token: "t" },
      {
        fetch: (async () => {
          calls++;
          return new Response(JSON.stringify({ issues: [{ key: `X-${calls}` }], nextPageToken: "same" }), { status: 200 });
        }) as typeof fetch,
      },
    );
    const result = await looping.search({ jql: "x", fields: [], limit: 50 });
    expect(calls).toBe(2);
    expect(result.issues).toHaveLength(2);
    expect(result.hasMore).toBe(false);
  });

  it("never calls the removed /rest/api/3/search", async () => {
    await client().search({ jql: "project = OPS", fields: ROW_FIELDS, limit: 5 });
    expect(mock.state.requests.every((request) => request.path !== "/rest/api/3/search")).toBe(true);
  });

  it("maps a wrong token to unauthorized", async () => {
    const failure = await failureOf(client({ token: "wrong" }).myself());
    expect(failure.kind).toBe("unauthorized");
    expect(failure.message).not.toContain("wrong");
  });

  it("maps a CAPTCHA lockout to unauthorized with guidance", async () => {
    mock.state.mode = "captcha";
    const failure = await failureOf(client().myself());
    expect(failure.kind).toBe("unauthorized");
    expect(failure.message).toMatch(/browser/);
  });

  it("maps 403 to forbidden", async () => {
    mock.state.mode = "forbidden";
    expect((await failureOf(client().getIssue("ENG-412", ROW_FIELDS))).kind).toBe("forbidden");
  });

  it("maps 404 to not_found with Jira's message", async () => {
    const failure = await failureOf(client().getIssue("ENG-9999", ROW_FIELDS));
    expect(failure.kind).toBe("not_found");
    expect(failure.message).toMatch(/does not exist/);
  });

  it("maps invalid JQL to bad_request with Jira's message", async () => {
    const failure = await failureOf(client().search({ jql: "bogus = 1", fields: ROW_FIELDS, limit: 5 }));
    expect(failure.kind).toBe("bad_request");
    expect(failure.message).toMatch(/Field 'bogus'/);
  });

  it("honours Retry-After and blocks further requests until it passes", async () => {
    mock.state.mode = "rate_limited";
    mock.state.retryAfter = 120;
    const gate = new RateGate();
    const failure = await failureOf(client({ gate }).myself());
    expect(failure.kind).toBe("rate_limited");
    expect(failure.retryAfterMs).toBe(120_000);
    mock.state.mode = "ok";
    const before = mock.count();
    const second = await failureOf(client({ gate }).myself());
    expect(second.kind).toBe("rate_limited");
    expect(mock.count()).toBe(before); // no request while blocked
  });

  it("retries once inline when Retry-After is short", async () => {
    const responses = [
      new Response("{}", { status: 429, headers: { "retry-after": "0" } }),
      new Response(JSON.stringify({ accountId: "a" }), { status: 200 }),
    ];
    let calls = 0;
    const scripted = new JiraClient(
      { apiBaseUrl: "https://inline.example", email: "a@b.c", token: "t" },
      { fetch: (async () => responses[calls++]!) as typeof fetch },
    );
    await expect(scripted.myself()).resolves.toEqual({ accountId: "a" });
    expect(calls).toBe(2);
  });

  it("maps 5xx to server", async () => {
    mock.state.mode = "server_error";
    expect((await failureOf(client().myself())).kind).toBe("server");
  });

  it("maps a non-JSON success to invalid_response", async () => {
    mock.state.mode = "html";
    expect((await failureOf(client().myself())).kind).toBe("invalid_response");
  });

  it("times out slow responses", async () => {
    mock.state.mode = "slow";
    const failure = await failureOf(client({ timeoutMs: 200 }).myself());
    expect(failure.kind).toBe("timeout");
  });

  it("maps a refused connection to network", async () => {
    const failure = await failureOf(client({ base: "http://127.0.0.1:1" }).myself());
    expect(failure.kind).toBe("network");
  });

  it("aborts with the caller's signal and reports an abort, not a failure", async () => {
    mock.state.mode = "slow";
    const controller = new AbortController();
    const pending = client({ timeoutMs: 10_000 }).myself(controller.signal);
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("parses Retry-After seconds and HTTP dates", () => {
    expect(parseRetryAfter("7", 0)).toBe(7_000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 0)).toBe(10_000);
    expect(parseRetryAfter("soon", 0)).toBeNull();
    expect(parseRetryAfter(null, 0)).toBeNull();
  });
});
