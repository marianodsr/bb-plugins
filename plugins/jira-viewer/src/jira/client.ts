// Jira Cloud REST v3 client: Basic auth with an API token, per-request
// timeouts that also follow the caller's AbortSignal, Retry-After aware rate
// limiting, and failures mapped to states the UI can explain.
//
// The token is only ever placed in the Authorization header. It never appears
// in errors, logs or return values.
import type { Failure, FailureKind } from "../schemas.js";

export interface JiraConnection {
  apiBaseUrl: string;
  email: string;
  token: string;
}

export class JiraError extends Error {
  readonly failure: Failure;
  constructor(failure: Failure) {
    super(failure.message);
    this.name = "JiraError";
    this.failure = failure;
  }
}

export function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "CanceledError")
  );
}

export function makeFailure(
  kind: FailureKind,
  message: string,
  extra: { status?: number | null; retryAfterMs?: number | null; at?: number } = {},
): Failure {
  return {
    kind,
    message,
    status: extra.status ?? null,
    retryAfterMs: extra.retryAfterMs ?? null,
    at: extra.at ?? Date.now(),
  };
}

/** Shared across client instances so a new client honours an old Retry-After. */
export class RateGate {
  blockedUntil = 0;
}

export interface JiraClientOptions {
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
  gate?: RateGate;
  /** Wait and retry once when Retry-After is at most this long. */
  maxInlineRetryMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface SearchPage {
  issues: unknown[];
  nextPageToken: string | null;
}

export interface SearchResult {
  issues: unknown[];
  /** Token for the page after the last one fetched, when there is one. */
  nextPageToken: string | null;
  hasMore: boolean;
}

export const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRY_AFTER_MS = 30_000;
/** Jira caps pages with fields at 100. */
export const MAX_PAGE_SIZE = 100;

export class JiraClient {
  private readonly connection: JiraConnection;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly gate: RateGate;
  private readonly maxInlineRetryMs: number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(connection: JiraConnection, options: JiraClientOptions = {}) {
    this.connection = connection;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.gate = options.gate ?? new RateGate();
    this.maxInlineRetryMs = options.maxInlineRetryMs ?? 2_000;
    this.sleep = options.sleep ?? abortableSleep;
  }

  /** The signed-in account: verifies site, email and token in one call. */
  async myself(signal?: AbortSignal): Promise<unknown> {
    return this.request("GET", "/rest/api/3/myself", { signal });
  }

  async getIssue(
    key: string,
    fields: readonly string[],
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.request(
      "GET",
      `/rest/api/3/issue/${encodeURIComponent(key)}`,
      { query: { fields: fields.join(","), fieldsByKeys: "false" }, signal },
    );
  }

  /** One page of the enhanced JQL search (`/rest/api/3/search/jql`). */
  async searchPage(
    args: {
      jql: string;
      fields: readonly string[];
      maxResults: number;
      nextPageToken?: string | null;
    },
    signal?: AbortSignal,
  ): Promise<SearchPage> {
    const body: Record<string, unknown> = {
      jql: args.jql,
      fields: [...args.fields],
      maxResults: Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(args.maxResults))),
    };
    if (args.nextPageToken) body.nextPageToken = args.nextPageToken;
    const response = await this.request("POST", "/rest/api/3/search/jql", {
      body,
      signal,
    });
    if (typeof response !== "object" || response === null) {
      throw new JiraError(
        makeFailure("invalid_response", "Jira returned an unexpected search response.", {
          at: this.now(),
        }),
      );
    }
    const record = response as Record<string, unknown>;
    const issues = Array.isArray(record.issues) ? record.issues : [];
    const token =
      typeof record.nextPageToken === "string" && record.nextPageToken !== ""
        ? record.nextPageToken
        : null;
    // `isLast: true` wins over a stray token.
    return { issues, nextPageToken: record.isLast === true ? null : token };
  }

  /**
   * Follow page tokens until `limit` issues are collected or Jira has no more.
   * Guards against a token that repeats, which would otherwise loop forever.
   */
  async search(
    args: {
      jql: string;
      fields: readonly string[];
      limit: number;
      pageToken?: string | null;
    },
    signal?: AbortSignal,
  ): Promise<SearchResult> {
    const limit = Math.max(1, Math.floor(args.limit));
    const issues: unknown[] = [];
    const seen = new Set<string>();
    let token: string | null = args.pageToken ?? null;
    if (token) seen.add(token);
    for (;;) {
      const page = await this.searchPage(
        {
          jql: args.jql,
          fields: args.fields,
          maxResults: Math.min(MAX_PAGE_SIZE, limit - issues.length),
          nextPageToken: token,
        },
        signal,
      );
      issues.push(...page.issues);
      token = page.nextPageToken;
      if (!token || page.issues.length === 0) {
        return { issues: issues.slice(0, limit), nextPageToken: null, hasMore: false };
      }
      if (seen.has(token)) {
        // Jira handed back a token it already gave: stop, report what we have.
        return { issues: issues.slice(0, limit), nextPageToken: null, hasMore: false };
      }
      seen.add(token);
      if (issues.length >= limit) {
        return { issues: issues.slice(0, limit), nextPageToken: token, hasMore: true };
      }
    }
  }

  async request(
    method: "GET" | "POST",
    path: string,
    options: {
      query?: Record<string, string>;
      body?: unknown;
      signal?: AbortSignal;
    } = {},
    attempt = 0,
  ): Promise<unknown> {
    const now = this.now();
    if (this.gate.blockedUntil > now) {
      const wait = this.gate.blockedUntil - now;
      throw new JiraError(
        makeFailure("rate_limited", rateLimitMessage(wait), {
          retryAfterMs: wait,
          status: 429,
          at: now,
        }),
      );
    }
    options.signal?.throwIfAborted();

    const url = new URL(path, this.connection.apiBaseUrl);
    for (const [name, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(name, value);
    }
    const host = url.host;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.timeoutMs);
    const signal = options.signal
      ? anySignal([options.signal, timeout.signal])
      : timeout.signal;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        signal,
        redirect: "manual",
        headers: {
          Accept: "application/json",
          Authorization: `Basic ${basicAuth(this.connection.email, this.connection.token)}`,
          ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      });
    } catch (error) {
      clearTimeout(timer);
      if (options.signal?.aborted) throw abortError(options.signal);
      if (timeout.signal.aborted) {
        throw new JiraError(
          makeFailure(
            "timeout",
            `Jira at ${host} did not answer within ${Math.round(this.timeoutMs / 1000)} s.`,
            { at: this.now() },
          ),
        );
      }
      throw new JiraError(
        makeFailure("network", `Could not reach Jira at ${host}. Check the site and your connection.`, {
          at: this.now(),
        }),
      );
    }

    let text: string;
    try {
      text = await response.text();
    } catch {
      clearTimeout(timer);
      if (options.signal?.aborted) throw abortError(options.signal);
      if (timeout.signal.aborted) {
        throw new JiraError(
          makeFailure("timeout", `Jira at ${host} stopped answering mid-response.`, {
            at: this.now(),
          }),
        );
      }
      throw new JiraError(
        makeFailure("network", `The connection to Jira at ${host} dropped.`, {
          at: this.now(),
        }),
      );
    }
    clearTimeout(timer);

    if (response.status === 429 || (response.status === 503 && response.headers.has("retry-after"))) {
      const retryAfterMs =
        parseRetryAfter(response.headers.get("retry-after"), this.now()) ??
        DEFAULT_RETRY_AFTER_MS;
      if (attempt === 0 && retryAfterMs <= this.maxInlineRetryMs) {
        await this.sleep(retryAfterMs, options.signal);
        return this.request(method, path, options, attempt + 1);
      }
      this.gate.blockedUntil = Math.max(this.gate.blockedUntil, this.now() + retryAfterMs);
      throw new JiraError(
        makeFailure("rate_limited", rateLimitMessage(retryAfterMs), {
          status: response.status,
          retryAfterMs,
          at: this.now(),
        }),
      );
    }

    if (response.status >= 200 && response.status < 300) {
      if (text === "" || response.status === 204) return null;
      try {
        return JSON.parse(text);
      } catch {
        throw new JiraError(
          makeFailure(
            "invalid_response",
            `${host} did not answer like Jira Cloud. Check the site address.`,
            { status: response.status, at: this.now() },
          ),
        );
      }
    }
    throw new JiraError(mapHttpFailure(response, text, host, this.now()));
  }
}

function mapHttpFailure(response: Response, text: string, host: string, at: number): Failure {
  const status = response.status;
  const detail = jiraErrorDetail(text);
  if (status >= 300 && status < 400) {
    return makeFailure(
      "invalid_response",
      `${host} redirected the request. Check that the site is your Jira Cloud address.`,
      { status, at },
    );
  }
  if (status === 401) {
    return makeFailure(
      "unauthorized",
      "Jira rejected the email and API token. Check both in the plugin settings.",
      { status, at },
    );
  }
  if (status === 403) {
    // Jira answers 403 instead of 401 when it wants a CAPTCHA after failed logins.
    const reason = response.headers.get("x-seraph-loginreason") ?? "";
    if (/AUTHENTICATION_DENIED|AUTHENTICATED_FAILED/i.test(reason)) {
      return makeFailure(
        "unauthorized",
        "Jira is refusing API logins for this account after failed attempts. Sign in to Jira in a browser once, then try again.",
        { status, at },
      );
    }
    return makeFailure(
      "forbidden",
      detail
        ? `Jira says this account may not do that: ${detail}`
        : "This account does not have permission for that in Jira.",
      { status, at },
    );
  }
  if (status === 404) {
    return makeFailure(
      "not_found",
      detail ?? "Not found in Jira, or this account cannot see it.",
      { status, at },
    );
  }
  if (status === 400) {
    return makeFailure(
      "bad_request",
      detail ? `Jira could not run that: ${detail}` : "Jira could not run that request.",
      { status, at },
    );
  }
  if (status >= 500) {
    return makeFailure("server", `Jira had a problem (HTTP ${status}). Try again shortly.`, {
      status,
      at,
    });
  }
  return makeFailure("invalid_response", `Jira answered with HTTP ${status}.`, { status, at });
}

/** Pull Jira's `errorMessages` / `errors` text, bounded. */
export function jiraErrorDetail(text: string): string | null {
  if (text === "") return null;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const parts: string[] = [];
    if (Array.isArray(parsed.errorMessages)) {
      for (const message of parsed.errorMessages) {
        if (typeof message === "string" && message.trim()) parts.push(message.trim());
      }
    }
    if (parsed.errors && typeof parsed.errors === "object") {
      for (const [field, message] of Object.entries(parsed.errors as Record<string, unknown>)) {
        if (typeof message === "string" && message.trim()) parts.push(`${field}: ${message.trim()}`);
      }
    }
    if (typeof parsed.message === "string" && parsed.message.trim()) parts.push(parsed.message.trim());
    if (parts.length === 0) return null;
    const joined = parts.join(" ");
    return joined.length > 500 ? `${joined.slice(0, 497)}...` : joined;
  } catch {
    return null;
  }
}

/** Retry-After is either delta-seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, now: number): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Math.min(Math.round(Number(trimmed) * 1000), 3_600_000);
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.min(Math.max(0, date - now), 3_600_000);
}

function rateLimitMessage(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  return `Jira is rate limiting requests. Try again in ${seconds} s.`;
}

function basicAuth(email: string, token: string): string {
  return Buffer.from(`${email}:${token}`, "utf8").toString("base64");
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error && reason.name === "AbortError") return reason;
  const error = new Error("The request was cancelled.");
  error.name = "AbortError";
  return error;
}

/** `AbortSignal.any` without depending on the runtime having it. */
export function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
  }
  const onAbort = (event: Event) => {
    const source = event.target as AbortSignal;
    controller.abort(source.reason);
    for (const signal of signals) signal.removeEventListener("abort", onAbort);
  };
  for (const signal of signals) signal.addEventListener("abort", onAbort, { once: true });
  return controller.signal;
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal!));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
