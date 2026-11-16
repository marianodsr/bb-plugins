// A small Jira Cloud REST v3 mock for development and tests.
//
//   node mock/server.ts [--port 4010]
//
// Endpoints: GET /rest/api/3/myself, GET /rest/api/3/issue/{key},
// GET|POST /rest/api/3/search/jql (token pagination). The removed legacy
// /rest/api/3/search answers 410 like Jira Cloud does now.
//
// Control (no auth): POST /__mock/mode {"mode": "...", "retryAfter": s, "delayMs": n},
// GET /__mock/stats, POST /__mock/reset, POST /__mock/touch {"key", "summary"?, "status"?},
// POST /__mock/remove {"key"}. Modes: ok, unauthorized, forbidden, captcha,
// rate_limited, server_error, html, slow.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { MOCK_EMAIL, MOCK_TOKEN, buildIssues, statuses, users, type FixtureIssue } from "./fixtures.ts";

export type MockMode =
  | "ok"
  | "unauthorized"
  | "forbidden"
  | "captcha"
  | "rate_limited"
  | "server_error"
  | "html"
  | "slow";

export interface MockState {
  mode: MockMode;
  retryAfter: number;
  delayMs: number;
  issues: Map<string, FixtureIssue>;
  viewed: string[];
  requests: { method: string; path: string; at: number }[];
}

export interface MockJira {
  url: string;
  state: MockState;
  /** Count requests whose path starts with `prefix` (default: Jira API only). */
  count(prefix?: string): number;
  reset(): void;
  close(): Promise<void>;
}

const EXPECTED_AUTH = `Basic ${Buffer.from(`${MOCK_EMAIL}:${MOCK_TOKEN}`).toString("base64")}`;

class JqlError extends Error {}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": typeof body === "string" ? "text/html; charset=utf-8" : "application/json",
    ...headers,
  });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (text === "") return {};
  return JSON.parse(text);
}

function pickFields(issue: FixtureIssue, fields: string[] | null): FixtureIssue {
  if (!fields || fields.includes("*all") || fields.includes("*navigable")) return issue;
  const picked: Record<string, unknown> = {};
  for (const field of fields) {
    if (field in issue.fields) picked[field] = issue.fields[field];
  }
  return { ...issue, fields: picked };
}

// ---------------------------------------------------------------- JQL subset

type Predicate = (issue: FixtureIssue) => boolean;

function unquote(value: string): string {
  const trimmed = value.trim();
  if (/^".*"$/.test(trimmed) || /^'.*'$/.test(trimmed)) return trimmed.slice(1, -1).replace(/\\"/g, '"');
  return trimmed;
}

function list(value: string): string[] {
  const inner = value.trim().replace(/^\(/, "").replace(/\)$/, "");
  return inner.split(",").map((part) => unquote(part).toUpperCase()).filter(Boolean);
}

function text(issue: FixtureIssue): string {
  return JSON.stringify([issue.fields.summary, issue.fields.description, issue.fields.comment]).toLowerCase();
}

function parseJql(jql: string, state: MockState): { predicates: Predicate[]; order: string | null } {
  const [where, order] = jql.split(/\s+ORDER\s+BY\s+/i);
  const predicates: Predicate[] = [];
  const clauses = (where ?? "").trim() === "" ? [] : where!.split(/\s+AND\s+/i);
  for (const raw of clauses) {
    const clause = raw.trim();
    if (/\sOR\s/i.test(clause)) throw new JqlError("The mock supports AND only.");
    let m: RegExpExecArray | null;
    if ((m = /^(project)\s*=\s*(.+)$/i.exec(clause))) {
      const key = unquote(m[2]!).toUpperCase();
      predicates.push((issue) => (issue.fields.project as { key: string }).key === key);
    } else if ((m = /^project\s+in\s+(.+)$/i.exec(clause))) {
      const keys = list(m[1]!);
      predicates.push((issue) => keys.includes((issue.fields.project as { key: string }).key));
    } else if ((m = /^(key|issuekey|issue)\s*=\s*(.+)$/i.exec(clause))) {
      const key = unquote(m[2]!).toUpperCase();
      predicates.push((issue) => issue.key === key);
    } else if ((m = /^(key|issuekey|issue)\s+in\s+issueHistory\(\)$/i.exec(clause))) {
      predicates.push((issue) => state.viewed.includes(issue.key));
    } else if ((m = /^(key|issuekey|issue)\s+in\s+(\(.+\))$/i.exec(clause))) {
      const keys = list(m[2]!);
      predicates.push((issue) => keys.includes(issue.key));
    } else if ((m = /^(assignee|reporter)\s*=\s*currentUser\(\)$/i.exec(clause))) {
      const field = m[1]!.toLowerCase();
      predicates.push((issue) => (issue.fields[field] as { accountId?: string } | null)?.accountId === users.me.accountId);
    } else if ((m = /^assignee\s+is\s+(EMPTY|null)$/i.exec(clause))) {
      predicates.push((issue) => issue.fields.assignee === null);
    } else if ((m = /^statusCategory\s*(!=|=)\s*(.+)$/i.exec(clause))) {
      const negate = m[1] === "!=";
      const wanted = unquote(m[2]!).toLowerCase();
      predicates.push((issue) => {
        const category = (issue.fields.status as { statusCategory: { name: string; key: string } }).statusCategory;
        const match = category.name.toLowerCase() === wanted || category.key === wanted;
        return negate ? !match : match;
      });
    } else if ((m = /^status\s*(!=|=)\s*(.+)$/i.exec(clause))) {
      const negate = m[1] === "!=";
      const wanted = unquote(m[2]!).toLowerCase();
      predicates.push((issue) => {
        const match = (issue.fields.status as { name: string }).name.toLowerCase() === wanted;
        return negate ? !match : match;
      });
    } else if ((m = /^(text|summary)\s*~\s*(.+)$/i.exec(clause))) {
      const field = m[1]!.toLowerCase();
      const words = unquote(m[2]!).toLowerCase().split(/\s+/).filter(Boolean);
      predicates.push((issue) => {
        const haystack = field === "summary" ? String(issue.fields.summary).toLowerCase() : text(issue);
        return words.every((word) => haystack.includes(word));
      });
    } else {
      const field = /^([\w."]+)/.exec(clause)?.[1] ?? clause;
      throw new JqlError(`Error in the JQL Query: Field '${field}' does not exist or you do not have permission to view it.`);
    }
  }
  return { predicates, order: order?.trim() ?? null };
}

function runJql(jql: string, state: MockState): FixtureIssue[] {
  const { predicates, order } = parseJql(jql, state);
  const all = [...state.issues.values()].filter((issue) => predicates.every((p) => p(issue)));
  if (order && /lastViewed/i.test(order)) {
    return state.viewed.map((key) => state.issues.get(key)).filter((issue): issue is FixtureIssue => issue !== undefined && all.includes(issue));
  }
  const field = order ? (/^(\w+)/.exec(order)?.[1] ?? "updated") : "updated";
  const descending = !order || /\bDESC\b/i.test(order);
  return all.sort((a, b) => {
    const left = String(a.fields[field] ?? a.key);
    const right = String(b.fields[field] ?? b.key);
    return descending ? right.localeCompare(left) : left.localeCompare(right);
  });
}

function encodeToken(offset: number, jql: string): string {
  return Buffer.from(JSON.stringify({ offset, jql })).toString("base64url");
}

function decodeToken(token: string): { offset: number; jql: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as { offset: number; jql: string };
    return typeof parsed.offset === "number" ? parsed : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- server

export async function startMockJira(options: { port?: number; host?: string } = {}): Promise<MockJira> {
  const host = options.host ?? "127.0.0.1";
  let baseUrl = "";
  const state: MockState = {
    mode: "ok",
    retryAfter: 30,
    delayMs: 0,
    issues: new Map(),
    viewed: [],
    requests: [],
  };
  const reset = () => {
    state.mode = "ok";
    state.retryAfter = 30;
    state.delayMs = 0;
    state.issues = buildIssues(baseUrl);
    state.viewed = ["ENG-412", "ENG-398", "OPS-7"];
    state.requests = [];
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      send(res, 500, { errorMessages: [String(error)] });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", baseUrl);
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (path.startsWith("/__mock/")) {
      const body = method === "POST" ? ((await readBody(req)) as Record<string, unknown>) : {};
      if (path === "/__mock/stats") {
        return send(res, 200, { mode: state.mode, requests: state.requests });
      }
      if (path === "/__mock/reset") {
        reset();
        return send(res, 200, { ok: true });
      }
      if (path === "/__mock/mode") {
        state.mode = (body.mode as MockMode) ?? "ok";
        if (typeof body.retryAfter === "number") state.retryAfter = body.retryAfter;
        if (typeof body.delayMs === "number") state.delayMs = body.delayMs;
        return send(res, 200, { mode: state.mode, retryAfter: state.retryAfter, delayMs: state.delayMs });
      }
      if (path === "/__mock/touch") {
        const issue = state.issues.get(String(body.key));
        if (!issue) return send(res, 404, { errorMessages: ["no such fixture"] });
        if (typeof body.summary === "string") issue.fields.summary = body.summary;
        if (typeof body.status === "string" && body.status in statuses) {
          issue.fields.status = statuses[body.status as keyof typeof statuses];
        }
        issue.fields.updated = new Date().toISOString().replace("Z", "+0000");
        return send(res, 200, { key: issue.key, summary: issue.fields.summary });
      }
      if (path === "/__mock/remove") {
        return send(res, 200, { removed: state.issues.delete(String(body.key)) });
      }
      return send(res, 404, { errorMessages: ["unknown mock control"] });
    }

    state.requests.push({ method, path, at: Date.now() });
    const delay = state.mode === "slow" ? Math.max(state.delayMs, 5_000) : state.delayMs;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));

    if (state.mode === "html") {
      return send(res, 200, "<!doctype html><title>Log in</title><p>Not Jira.</p>");
    }
    if (state.mode === "server_error") {
      return send(res, 500, { errorMessages: ["Internal server error"] });
    }
    if (state.mode === "rate_limited") {
      return send(res, 429, { errorMessages: ["Rate limit exceeded."] }, { "retry-after": String(state.retryAfter) });
    }
    if (state.mode === "captcha") {
      return send(res, 403, "", { "x-seraph-loginreason": "AUTHENTICATION_DENIED" });
    }
    if (state.mode === "unauthorized" || req.headers.authorization !== EXPECTED_AUTH) {
      return send(res, 401, { errorMessages: ["You are not authenticated. Authentication required to perform this operation."] });
    }
    if (state.mode === "forbidden") {
      return send(res, 403, { errorMessages: ["You do not have the permission to see the specified issue."] });
    }

    if (path === "/rest/api/3/myself" && method === "GET") {
      return send(res, 200, { self: `${baseUrl}/rest/api/3/user?accountId=${users.me.accountId}`, ...users.me });
    }

    if (path === "/rest/api/3/search" || path === "/rest/api/2/search") {
      return send(res, 410, {
        errorMessages: ["The requested API has been removed. Please migrate to the /rest/api/3/search/jql API."],
      });
    }

    if (path === "/rest/api/3/search/jql") {
      let jql = "";
      let maxResults = 50;
      let fields: string[] | null = null;
      let token: string | null = null;
      if (method === "POST") {
        const body = (await readBody(req)) as Record<string, unknown>;
        jql = typeof body.jql === "string" ? body.jql : "";
        if (typeof body.maxResults === "number") maxResults = body.maxResults;
        if (Array.isArray(body.fields)) fields = body.fields as string[];
        if (typeof body.nextPageToken === "string") token = body.nextPageToken;
      } else {
        jql = url.searchParams.get("jql") ?? "";
        maxResults = Number(url.searchParams.get("maxResults") ?? 50);
        fields = url.searchParams.get("fields")?.split(",") ?? null;
        token = url.searchParams.get("nextPageToken");
      }
      if (jql.trim() === "") {
        return send(res, 400, { errorMessages: ["Unbounded JQL queries are not allowed here. Please add a search restriction."] });
      }
      // Jira returns only ids when no fields are requested.
      const limit = Math.min(fields && fields.length > 0 ? 100 : 5000, Math.max(1, maxResults));
      let offset = 0;
      if (token) {
        const decoded = decodeToken(token);
        if (!decoded || decoded.jql !== jql) {
          return send(res, 400, { errorMessages: ["The provided next page token is invalid or expired."] });
        }
        offset = decoded.offset;
      }
      let matches: FixtureIssue[];
      try {
        matches = runJql(jql, state);
      } catch (error) {
        if (error instanceof JqlError) return send(res, 400, { errorMessages: [error.message], warningMessages: [] });
        throw error;
      }
      const page = matches.slice(offset, offset + limit);
      const isLast = offset + limit >= matches.length;
      const body: Record<string, unknown> = {
        issues: page.map((issue) => (fields && fields.length > 0 ? pickFields(issue, fields) : { id: issue.id })),
        isLast,
      };
      if (!isLast) body.nextPageToken = encodeToken(offset + limit, jql);
      return send(res, 200, body);
    }

    const issueMatch = /^\/rest\/api\/3\/issue\/([^/]+)$/.exec(path);
    if (issueMatch && method === "GET") {
      const key = decodeURIComponent(issueMatch[1]!).toUpperCase();
      const issue = state.issues.get(key);
      if (!issue) {
        return send(res, 404, { errorMessages: ["Issue does not exist or you do not have permission to see it."], errors: {} });
      }
      state.viewed = [key, ...state.viewed.filter((viewed) => viewed !== key)].slice(0, 50);
      const fields = url.searchParams.get("fields")?.split(",").filter(Boolean) ?? null;
      return send(res, 200, pickFields(issue, fields));
    }

    return send(res, 404, { errorMessages: [`No mock for ${method} ${path}`] });
  }

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, host, resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://${host}:${address.port}`;
  reset();

  return {
    url: baseUrl,
    state,
    count: (prefix = "/rest/") => state.requests.filter((request) => request.path.startsWith(prefix)).length,
    reset,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const portFlag = process.argv.indexOf("--port");
  const port = portFlag > -1 ? Number(process.argv[portFlag + 1]) : 4010;
  const mock = await startMockJira({ port });
  console.log(`Mock Jira on ${mock.url}`);
  console.log(`  email: ${MOCK_EMAIL}`);
  console.log(`  token: ${MOCK_TOKEN}`);
}
