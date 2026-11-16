// The plugin's core: cache-first reads that refresh behind the caller,
// connection status, saved views and thread links. RPC, CLI, tools and the
// mention provider all go through this one object so every write invalidates
// the same tags.
import {
  connectionIdentity,
  isReady,
  type ReadyConfig,
  type ResolvedConfig,
} from "./config.js";
import {
  JiraClient,
  JiraError,
  RateGate,
  isAbortError,
  makeFailure,
} from "./jira/client.js";
import {
  DOCUMENT_FIELDS,
  ROW_FIELDS,
  normalizeAccount,
  normalizeDocument,
  normalizeRow,
} from "./jira/normalize.js";
import type {
  Failure,
  IssueDocument,
  IssueResult,
  IssueRow,
  IssueSummary,
  ListResult,
  StatusResult,
  View,
} from "./schemas.js";
import { queryIdFor, Store } from "./store.js";
import { TAGS } from "./tags.js";

export { TAGS };


export interface Timing {
  listStaleMs: number;
  docStaleMs: number;
  summaryFreshMs: number;
  /** How long a read with nothing cached waits for the first fetch. */
  firstLoadWaitMs: number;
  requestTimeoutMs: number;
}

export const DEFAULT_TIMING: Timing = {
  listStaleMs: 60_000,
  docStaleMs: 120_000,
  summaryFreshMs: 600_000,
  firstLoadWaitMs: 2_500,
  requestTimeoutMs: 15_000,
};

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface TaskBoardAdapter {
  available(): Promise<boolean>;
  createTask(input: {
    title: string;
    body?: string;
    projectId?: string;
    externalRef: { kind: "jira"; key: string; url: string };
  }): Promise<{ id: string }>;
}

export interface ServiceDeps {
  store: Store;
  readConfig: () => Promise<ResolvedConfig>;
  invalidate: (tags: string[]) => void;
  invalidateAll: () => void;
  log: Logger;
  /** Aborted when the plugin unloads; background refreshes follow it. */
  lifetime: AbortSignal;
  now?: () => number;
  fetch?: typeof fetch;
  timing?: Partial<Timing>;
  taskBoard?: TaskBoardAdapter;
}

/** Failures that say something about the connection, not one resource. */
const CONNECTION_KINDS = new Set<Failure["kind"]>([
  "unauthorized",
  "network",
  "timeout",
  "invalid_response",
  "rate_limited",
]);

export const NOT_CONFIGURED_MESSAGE =
  "Jira Viewer is not set up. Add your Jira site, account email and API token in Settings → Installed plugins → Jira Viewer.";

export class NotConfiguredError extends JiraError {
  constructor(at: number) {
    super(makeFailure("not_configured", NOT_CONFIGURED_MESSAGE, { at }));
  }
}

export class JiraViewerService {
  private readonly store: Store;
  private readonly deps: ServiceDeps;
  private readonly now: () => number;
  private readonly timing: Timing;
  private readonly gate = new RateGate();
  private readonly inFlight = new Map<string, Promise<Failure | null>>();
  private readonly lastErrors = new Map<string, Failure>();
  private client: { identity: string; token: string; client: JiraClient } | null = null;
  private connectionError: Failure | null = null;
  private account: { accountId: string; displayName: string } | null = null;
  private checkedAt: number | null = null;
  private lastPrune = 0;
  private taskBoardCache: { value: boolean; at: number } | null = null;

  constructor(deps: ServiceDeps) {
    this.deps = deps;
    this.store = deps.store;
    this.now = deps.now ?? Date.now;
    this.timing = { ...DEFAULT_TIMING, ...deps.timing };
  }

  // ------------------------------------------------------------ config

  private async ready(): Promise<{ config: ReadyConfig; client: JiraClient }> {
    const config = await this.deps.readConfig();
    if (!isReady(config)) throw new NotConfiguredError(this.now());
    const identity = connectionIdentity(config);
    if (!this.client || this.client.identity !== identity || this.client.token !== config.token) {
      this.client = {
        identity,
        token: config.token,
        client: new JiraClient(
          { apiBaseUrl: config.apiBaseUrl, email: config.email, token: config.token },
          {
            fetch: this.deps.fetch,
            now: this.now,
            gate: this.gate,
            timeoutMs: this.timing.requestTimeoutMs,
          },
        ),
      };
    }
    return { config, client: this.client.client };
  }

  /** Settings changed. A different site or account drops every cached issue. */
  onConfigChanged(previous: ResolvedConfig, next: ResolvedConfig): void {
    const identityChanged = connectionIdentity(previous) !== connectionIdentity(next);
    this.client = null;
    this.connectionError = null;
    this.account = null;
    this.checkedAt = null;
    this.lastErrors.clear();
    this.gate.blockedUntil = 0;
    if (identityChanged) {
      this.store.clearCache();
      this.deps.log.info("Jira connection changed; cleared the issue cache.");
    }
    this.deps.invalidateAll();
  }

  private noteSuccess(): void {
    if (this.connectionError !== null) {
      this.connectionError = null;
      this.deps.invalidate([TAGS.status]);
    }
  }

  private noteFailure(failure: Failure): void {
    if (!CONNECTION_KINDS.has(failure.kind)) return;
    const previous = this.connectionError;
    this.connectionError = failure;
    if (!previous || previous.kind !== failure.kind) {
      this.deps.log.warn(`Jira request failed: ${failure.kind} (${failure.status ?? "no status"})`);
      this.deps.invalidate([TAGS.status]);
    }
  }

  /** Run a Jira call, recording connection-level success or failure. */
  private async call<T>(run: (client: JiraClient, config: ReadyConfig) => Promise<T>): Promise<T> {
    const { client, config } = await this.ready();
    try {
      const result = await run(client, config);
      this.noteSuccess();
      return result;
    } catch (error) {
      if (error instanceof JiraError) this.noteFailure(error.failure);
      throw error;
    }
  }

  private toFailure(error: unknown): Failure {
    if (error instanceof JiraError) return error.failure;
    this.deps.log.error(`Unexpected error talking to Jira: ${errorText(error)}`);
    return makeFailure("invalid_response", "Something unexpected went wrong reading from Jira.", {
      at: this.now(),
    });
  }

  private maybePrune(): void {
    if (this.now() - this.lastPrune < 30_000) return;
    this.lastPrune = this.now();
    const removed = this.store.prune();
    if (removed.issues + removed.searches > 0) {
      this.deps.log.debug(`Pruned ${removed.issues} issues and ${removed.searches} searches from the cache.`);
    }
  }

  // ------------------------------------------------------------ status

  async status(): Promise<StatusResult> {
    const config = await this.deps.readConfig();
    const configured = isReady(config);
    const error = configured ? this.connectionError : null;
    const blocking =
      error !== null && error.kind !== "rate_limited" ? error : null;
    return {
      state: !configured ? "not_configured" : blocking ? "error" : "ready",
      configured,
      missing: config.missing,
      siteUrl: config.siteUrl,
      email: config.email,
      usingOverride: config.usingOverride,
      account: configured ? this.account : null,
      error,
      checkedAt: this.checkedAt,
      integrations: { taskBoard: await this.taskBoardAvailable() },
    };
  }

  /** Verify the credentials against `/myself`. */
  async checkConnection(signal?: AbortSignal): Promise<StatusResult> {
    try {
      const raw = await this.call((client) => client.myself(signal));
      this.account = normalizeAccount(raw);
      this.checkedAt = this.now();
      this.connectionError = null;
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (!(error instanceof NotConfiguredError)) {
        const failure = this.toFailure(error);
        this.account = null;
        this.checkedAt = this.now();
        // A 403/404 on /myself still means the connection is wrong.
        this.connectionError = failure;
      }
    }
    this.deps.invalidate([TAGS.status]);
    return this.status();
  }

  private async taskBoardAvailable(): Promise<boolean> {
    const adapter = this.deps.taskBoard;
    if (!adapter) return false;
    const cached = this.taskBoardCache;
    if (cached && this.now() - cached.at < 30_000) return cached.value;
    let value = false;
    try {
      value = await adapter.available();
    } catch {
      value = false;
    }
    this.taskBoardCache = { value, at: this.now() };
    return value;
  }

  /**
   * A read that just failed waits before trying again, so a failing query
   * (bad JQL, Jira down, rate limited) does not refetch on every read and
   * every invalidation. Only an explicit refresh (`force`) skips the wait.
   */
  private backingOff(id: string, intervalMs: number): boolean {
    const failure = this.lastErrors.get(id);
    if (!failure) return false;
    const wait = Math.max(intervalMs, failure.retryAfterMs ?? 0);
    return this.now() - failure.at < wait;
  }

  // ------------------------------------------------------------ lists

  /** Resolve `{ viewId }` or `{ jql }` into the JQL to run. */
  resolveSource(input: { viewId?: string | undefined; jql?: string | undefined }): {
    viewId: string | null;
    jql: string;
  } | null {
    if (input.viewId) {
      const view = this.store.getView(input.viewId);
      return view ? { viewId: view.id, jql: view.jql } : null;
    }
    if (input.jql && input.jql.trim() !== "") return { viewId: null, jql: input.jql.trim() };
    return null;
  }

  /**
   * Cache-first list. Serves what is stored at once and refreshes behind it
   * when stale; with nothing stored it waits briefly for the first fetch.
   */
  async list(
    source: { viewId: string | null; jql: string },
    options: { limit: number; signal?: AbortSignal; force?: boolean },
  ): Promise<ListResult> {
    const queryId = queryIdFor(source.jql);
    const config = await this.deps.readConfig();
    if (!isReady(config)) {
      return {
        queryId,
        viewId: source.viewId,
        jql: source.jql,
        issues: [],
        hasMore: false,
        fetchedAt: null,
        stale: false,
        refreshing: false,
        error: makeFailure("not_configured", NOT_CONFIGURED_MESSAGE, { at: this.now() }),
      };
    }
    let cached = this.store.getSearch(queryId);
    const needsMore = cached !== null && cached.fetchedLimit < options.limit && cached.hasMore;
    const stale =
      cached === null ||
      needsMore ||
      options.force === true ||
      this.now() - cached.fetchedAt > this.timing.listStaleMs;
    if (stale && (options.force === true || !this.backingOff(`list:${queryId}`, this.timing.listStaleMs))) {
      const refresh = this.refreshList(source.jql, Math.max(options.limit, cached?.fetchedLimit ?? 0));
      if (cached === null || options.force) {
        await waitAtMost(refresh, options.force ? this.timing.requestTimeoutMs + 1000 : this.timing.firstLoadWaitMs, options.signal);
        cached = this.store.getSearch(queryId);
      }
    } else {
      this.store.touchSearch(queryId, this.now());
    }
    return this.buildList(queryId, source, options.limit, cached);
  }

  private buildList(
    queryId: string,
    source: { viewId: string | null; jql: string },
    limit: number,
    cached: ReturnType<Store["getSearch"]>,
  ): ListResult {
    const keys = cached ? cached.keys.slice(0, limit) : [];
    const rows = this.store.getRows(keys);
    const issues = keys
      .map((key) => rows.get(key)?.row)
      .filter((row): row is IssueRow => row !== undefined);
    if (issues.length > 0) this.store.touchIssues(keys, this.now());
    const fetchedAt = cached?.fetchedAt ?? null;
    return {
      queryId,
      viewId: source.viewId,
      jql: source.jql,
      issues,
      hasMore: cached ? cached.hasMore || cached.keys.length > limit : false,
      fetchedAt,
      stale: fetchedAt === null || this.now() - fetchedAt > this.timing.listStaleMs,
      refreshing: this.inFlight.has(`list:${queryId}`),
      error: this.lastErrors.get(`list:${queryId}`) ?? null,
    };
  }

  /** Refresh one search into the cache. Concurrent calls share one request. */
  refreshList(jql: string, limit: number): Promise<Failure | null> {
    const queryId = queryIdFor(jql);
    const id = `list:${queryId}`;
    const existing = this.inFlight.get(id);
    if (existing) return existing;
    const run = (async (): Promise<{ failure: Failure | null; changedKeys: string[] }> => {
      try {
        const result = await this.call((client) =>
          client.search({ jql, fields: ROW_FIELDS, limit }, this.deps.lifetime),
        );
        const { config } = await this.ready();
        const rows = result.issues
          .map((raw) => normalizeRow(raw, config.siteUrl))
          .filter((row): row is IssueRow => row !== null);
        const now = this.now();
        const changedKeys = this.store.upsertRows(rows, now);
        this.store.putSearch(
          {
            queryId,
            jql,
            keys: rows.map((row) => row.key),
            hasMore: result.hasMore,
            fetchedLimit: limit,
            fetchedAt: now,
          },
          now,
        );
        this.lastErrors.delete(id);
        this.maybePrune();
        return { failure: null, changedKeys };
      } catch (error) {
        if (isAbortError(error)) return { failure: null, changedKeys: [] };
        const failure = this.toFailure(error);
        this.lastErrors.set(id, failure);
        return { failure, changedKeys: [] };
      }
    })();
    const tracked = run.then(({ failure, changedKeys }) => {
      this.inFlight.delete(id);
      // Always invalidate the search so `refreshing` and `fetchedAt` update.
      if (!this.deps.lifetime.aborted) {
        this.deps.invalidate([TAGS.search(queryId), ...changedKeys.map(TAGS.issue)]);
      }
      return failure;
    });
    this.inFlight.set(id, tracked);
    return tracked;
  }

  /** Fresh search for tools and the CLI; fills the row cache on the way. */
  async searchFresh(
    args: { jql: string; limit: number; pageToken?: string | null },
    signal?: AbortSignal,
  ): Promise<{ issues: IssueRow[]; nextPageToken: string | null; hasMore: boolean }> {
    const result = await this.call((client) =>
      client.search(
        { jql: args.jql, fields: ROW_FIELDS, limit: args.limit, pageToken: args.pageToken ?? null },
        signal,
      ),
    );
    const { config } = await this.ready();
    const rows = result.issues
      .map((raw) => normalizeRow(raw, config.siteUrl))
      .filter((row): row is IssueRow => row !== null);
    const changed = this.store.upsertRows(rows, this.now());
    if (changed.length > 0) this.deps.invalidate(changed.map(TAGS.issue));
    this.maybePrune();
    return { issues: rows, nextPageToken: result.nextPageToken, hasMore: result.hasMore };
  }

  // ------------------------------------------------------------ issues

  /** Cache-first issue document. */
  async issue(
    key: string,
    options: { signal?: AbortSignal; force?: boolean } = {},
  ): Promise<IssueResult> {
    const config = await this.deps.readConfig();
    if (!isReady(config)) {
      return {
        key,
        issue: null,
        row: null,
        fetchedAt: null,
        stale: false,
        refreshing: false,
        error: makeFailure("not_configured", NOT_CONFIGURED_MESSAGE, { at: this.now() }),
      };
    }
    let cached = this.store.getDoc(key);
    const stale =
      cached === null || options.force === true || this.now() - cached.fetchedAt > this.timing.docStaleMs;
    if (stale && (options.force === true || !this.backingOff(`issue:${key}`, this.timing.docStaleMs))) {
      const refresh = this.refreshIssue(key);
      if (cached === null || options.force) {
        await waitAtMost(
          refresh,
          options.force ? this.timing.requestTimeoutMs + 1000 : this.timing.firstLoadWaitMs,
          options.signal,
        );
        cached = this.store.getDoc(key);
      }
    } else {
      this.store.touchIssues([key], this.now());
    }
    const row = cached ? null : (this.store.getRows([key]).get(key)?.row ?? null);
    const fetchedAt = cached?.fetchedAt ?? null;
    return {
      key,
      issue: cached?.doc ?? null,
      row,
      fetchedAt,
      stale: fetchedAt === null || this.now() - fetchedAt > this.timing.docStaleMs,
      refreshing: this.inFlight.has(`issue:${key}`),
      error: this.lastErrors.get(`issue:${key}`) ?? null,
    };
  }

  refreshIssue(key: string): Promise<Failure | null> {
    const id = `issue:${key}`;
    const existing = this.inFlight.get(id);
    if (existing) return existing;
    const tracked = (async (): Promise<Failure | null> => {
      const tags = [TAGS.issue(key)];
      try {
        await this.fetchIssue(key, this.deps.lifetime, tags);
        this.lastErrors.delete(id);
        return null;
      } catch (error) {
        if (isAbortError(error)) return null;
        const failure = this.toFailure(error);
        this.lastErrors.set(id, failure);
        return failure;
      } finally {
        this.inFlight.delete(id);
        if (!this.deps.lifetime.aborted) this.deps.invalidate(tags);
      }
    })();
    this.inFlight.set(id, tracked);
    return tracked;
  }

  /**
   * Fetch a full issue now and store it. A 404 drops it from the cache and
   * from cached searches. `tags` collects what to invalidate; without it the
   * method invalidates itself.
   */
  async fetchIssue(key: string, signal?: AbortSignal, tags?: string[]): Promise<IssueDocument> {
    const collect = tags ?? [];
    try {
      const raw = await this.call((client) => client.getIssue(key, DOCUMENT_FIELDS, signal));
      const { config } = await this.ready();
      const doc = normalizeDocument(raw, config.siteUrl);
      if (!doc) {
        throw new JiraError(
          makeFailure("invalid_response", `Jira returned an issue without a key for ${key}.`, {
            at: this.now(),
          }),
        );
      }
      // Jira redirects a moved issue's old key to its new one.
      if (this.store.upsertDoc(doc, this.now())) {
        collect.push(TAGS.issue(doc.key));
        if (doc.key !== key) collect.push(TAGS.issue(key));
      }
      this.maybePrune();
      return doc;
    } catch (error) {
      if (error instanceof JiraError && error.failure.kind === "not_found") {
        if (this.store.deleteIssue(key)) collect.push(TAGS.issue(key));
        collect.push(...this.store.dropKeyFromSearches(key).map(TAGS.search));
      }
      throw error;
    } finally {
      if (!tags && collect.length > 0) this.deps.invalidate(collect);
    }
  }

  /** Cached document when fresh enough, otherwise fetched; falls back to cache. */
  async issueForReading(
    key: string,
    signal?: AbortSignal,
  ): Promise<{ doc: IssueDocument; fromCache: boolean; fetchedAt: number; failure: Failure | null }> {
    try {
      const doc = await this.fetchIssue(key, signal);
      return { doc, fromCache: false, fetchedAt: this.now(), failure: null };
    } catch (error) {
      if (isAbortError(error)) throw error;
      const failure = this.toFailure(error);
      const cached =
        failure.kind === "not_found" || failure.kind === "not_configured"
          ? null
          : this.store.getDoc(key);
      if (!cached) throw error;
      return { doc: cached.doc, fromCache: true, fetchedAt: cached.fetchedAt, failure };
    }
  }

  /** Cross-plugin summary: cached row when recent, else a quick fetch. */
  async issueSummary(key: string, signal?: AbortSignal): Promise<IssueSummary> {
    const config = await this.deps.readConfig();
    if (!isReady(config)) return null;
    const cached = this.store.getRows([key]).get(key);
    const toSummary = (row: IssueRow): IssueSummary => ({
      key: row.key,
      summary: row.summary,
      status: row.status,
      statusCategory: row.statusCategory,
      url: row.url,
    });
    if (cached && this.now() - cached.fetchedAt < this.timing.summaryFreshMs) {
      return toSummary(cached.row);
    }
    try {
      const raw = await this.call((client) => client.getIssue(key, ROW_FIELDS, signal));
      const row = normalizeRow(raw, config.siteUrl);
      if (!row) return cached ? toSummary(cached.row) : null;
      const changed = this.store.upsertRows([row], this.now());
      if (changed.length > 0) this.deps.invalidate(changed.map(TAGS.issue));
      return toSummary(row);
    } catch (error) {
      if (error instanceof JiraError && error.failure.kind === "not_found") {
        if (this.store.deleteIssue(key)) this.deps.invalidate([TAGS.issue(key)]);
        return null;
      }
      if (isAbortError(error)) throw error;
      return cached ? toSummary(cached.row) : null;
    }
  }

  /** Cached rows for these keys; missing ones are fetched in one search. */
  async rowsFor(keys: readonly string[]): Promise<IssueRow[]> {
    const cached = this.store.getRows(keys);
    const missing = keys.filter((key) => !cached.has(key));
    if (missing.length > 0 && isReady(await this.deps.readConfig())) {
      void this.refreshList(`key in (${missing.join(", ")})`, missing.length).catch(() => undefined);
    }
    return keys
      .map((key) => cached.get(key)?.row)
      .filter((row): row is IssueRow => row !== undefined);
  }

  findCachedRows(query: string, limit: number): IssueRow[] {
    return this.store.findRows(query, limit);
  }

  // ------------------------------------------------------------ views

  listViews(): View[] {
    return this.store.listViews();
  }

  findView(idOrName: string): View | null {
    return this.store.findView(idOrName);
  }

  createView(name: string, jql: string): View {
    const view = this.store.createView(name, jql, this.now());
    this.deps.invalidate([TAGS.views]);
    return view;
  }

  updateView(id: string, patch: { name?: string; jql?: string }): View | null {
    const view = this.store.updateView(id, patch, this.now());
    if (view) this.deps.invalidate([TAGS.views]);
    return view;
  }

  deleteView(id: string): boolean {
    const removed = this.store.deleteView(id);
    if (removed) this.deps.invalidate([TAGS.views]);
    return removed;
  }

  reorderViews(ids: readonly string[]): View[] {
    const views = this.store.reorderViews(ids, this.now());
    this.deps.invalidate([TAGS.views]);
    return views;
  }

  // ------------------------------------------------------------ threads

  linkThread(threadId: string, key: string): boolean {
    const added = this.store.linkThread(threadId, key, this.now());
    if (added) this.deps.invalidate([TAGS.thread(threadId)]);
    return added;
  }

  unlinkThread(threadId: string, key: string): boolean {
    const removed = this.store.unlinkThread(threadId, key);
    if (removed) this.deps.invalidate([TAGS.thread(threadId)]);
    return removed;
  }

  forgetThread(threadId: string): void {
    if (this.store.forgetThread(threadId) > 0) this.deps.invalidate([TAGS.thread(threadId)]);
  }

  threadIssueKeys(threadId: string): string[] {
    return this.store.threadIssueKeys(threadId);
  }

  // ------------------------------------------------------------ task board

  async addToTaskBoard(args: {
    key: string;
    projectId?: string;
    body: string;
    title: string;
    url: string;
  }): Promise<{ id: string }> {
    const adapter = this.deps.taskBoard;
    if (!adapter || !(await this.taskBoardAvailable())) {
      throw new Error("Task Board is not installed or not running.");
    }
    return adapter.createTask({
      title: args.title,
      body: args.body,
      ...(args.projectId ? { projectId: args.projectId } : {}),
      externalRef: { kind: "jira", key: args.key, url: args.url },
    });
  }

  // ------------------------------------------------------------ cache

  cacheStats() {
    return this.store.stats();
  }

  clearCache(): void {
    this.store.clearCache();
    this.lastErrors.clear();
    this.deps.invalidateAll();
  }
}

/** Await a promise for at most `ms`, or until `signal` aborts. Never rejects. */
async function waitAtMost(promise: Promise<unknown>, ms: number, signal?: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  await Promise.race([
    promise.catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
    new Promise<void>((resolve) => {
      if (!signal) return;
      if (signal.aborted) resolve();
      onAbort = () => resolve();
      signal.addEventListener("abort", onAbort, { once: true });
    }),
  ]);
  clearTimeout(timer);
  if (onAbort) signal?.removeEventListener("abort", onAbort);
}

export function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
