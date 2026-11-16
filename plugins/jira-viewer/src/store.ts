// Plugin-owned SQLite: the issue cache, cached search results, saved views,
// and thread links. Bounded: the least recently used rows are evicted.
import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  issueDocumentSchema,
  issueRowSchema,
  type IssueDocument,
  type IssueRow,
  type View,
} from "./schemas.js";

export const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS issues_cache (
     key TEXT PRIMARY KEY,
     json TEXT NOT NULL,
     fetched_at INTEGER NOT NULL,
     doc_json TEXT,
     doc_fetched_at INTEGER,
     accessed_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS issues_cache_accessed ON issues_cache (accessed_at)`,
  `CREATE TABLE IF NOT EXISTS search_cache (
     query_id TEXT PRIMARY KEY,
     jql TEXT NOT NULL,
     keys_json TEXT NOT NULL,
     has_more INTEGER NOT NULL,
     fetched_limit INTEGER NOT NULL,
     fetched_at INTEGER NOT NULL,
     accessed_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS views (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     jql TEXT NOT NULL,
     position REAL NOT NULL,
     builtin INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS thread_issues (
     thread_id TEXT NOT NULL,
     issue_key TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (thread_id, issue_key)
   )`,
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
];

export const DEFAULT_VIEWS: ReadonlyArray<{ id: string; name: string; jql: string }> = [
  {
    id: "my-open",
    name: "My open issues",
    jql: "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC",
  },
  {
    id: "reported",
    name: "Reported by me",
    jql: "reporter = currentUser() ORDER BY updated DESC",
  },
  {
    id: "recent",
    name: "Recent",
    jql: "issue in issueHistory() ORDER BY lastViewed DESC",
  },
];

export interface Limits {
  maxIssues: number;
  maxSearches: number;
}

export const DEFAULT_LIMITS: Limits = { maxIssues: 2000, maxSearches: 200 };

export interface CachedSearch {
  queryId: string;
  jql: string;
  keys: string[];
  hasMore: boolean;
  fetchedLimit: number;
  fetchedAt: number;
}

export function queryIdFor(jql: string): string {
  const normalized = jql.trim().replace(/\s+/g, " ");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

function parseRow(json: string): IssueRow | null {
  try {
    const parsed = issueRowSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function parseDoc(json: string | null): IssueDocument | null {
  if (json === null) return null;
  try {
    const parsed = issueDocumentSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Drop document-only keys so a row compares equal however it was fetched. */
export function rowOf(issue: IssueRow | IssueDocument): IssueRow {
  return issueRowSchema.parse(issue);
}

export class Store {
  constructor(
    private readonly db: Database.Database,
    private readonly limits: Limits = DEFAULT_LIMITS,
  ) {}

  // ------------------------------------------------------------ issues

  getRows(keys: readonly string[]): Map<string, { row: IssueRow; fetchedAt: number }> {
    const out = new Map<string, { row: IssueRow; fetchedAt: number }>();
    if (keys.length === 0) return out;
    const select = this.db.prepare<[string], { key: string; json: string; fetched_at: number }>(
      `SELECT key, json, fetched_at FROM issues_cache WHERE key = ?`,
    );
    for (const key of keys) {
      const found = select.get(key);
      if (!found) continue;
      const row = parseRow(found.json);
      if (row) out.set(found.key, { row, fetchedAt: found.fetched_at });
    }
    return out;
  }

  getDoc(key: string): { doc: IssueDocument; fetchedAt: number } | null {
    const found = this.db
      .prepare<[string], { doc_json: string | null; doc_fetched_at: number | null }>(
        `SELECT doc_json, doc_fetched_at FROM issues_cache WHERE key = ?`,
      )
      .get(key);
    if (!found || found.doc_fetched_at === null) return null;
    const doc = parseDoc(found.doc_json);
    return doc ? { doc, fetchedAt: found.doc_fetched_at } : null;
  }

  /** Store rows; returns the keys whose row content changed or is new. */
  upsertRows(rows: readonly IssueRow[], now: number): string[] {
    const changed: string[] = [];
    const select = this.db.prepare<[string], { json: string }>(
      `SELECT json FROM issues_cache WHERE key = ?`,
    );
    const upsert = this.db.prepare(
      `INSERT INTO issues_cache (key, json, fetched_at, accessed_at)
       VALUES (@key, @json, @now, @now)
       ON CONFLICT (key) DO UPDATE SET json = @json, fetched_at = @now, accessed_at = @now`,
    );
    this.db.transaction(() => {
      for (const row of rows) {
        const json = JSON.stringify(rowOf(row));
        const previous = select.get(row.key);
        if (!previous || previous.json !== json) changed.push(row.key);
        upsert.run({ key: row.key, json, now });
      }
    })();
    return changed;
  }

  /** Store a document (and its row); returns true when anything changed. */
  upsertDoc(doc: IssueDocument, now: number): boolean {
    const rowJson = JSON.stringify(rowOf(doc));
    const docJson = JSON.stringify(doc);
    const previous = this.db
      .prepare<[string], { json: string; doc_json: string | null }>(
        `SELECT json, doc_json FROM issues_cache WHERE key = ?`,
      )
      .get(doc.key);
    this.db
      .prepare(
        `INSERT INTO issues_cache (key, json, fetched_at, doc_json, doc_fetched_at, accessed_at)
         VALUES (@key, @rowJson, @now, @docJson, @now, @now)
         ON CONFLICT (key) DO UPDATE SET json = @rowJson, fetched_at = @now,
           doc_json = @docJson, doc_fetched_at = @now, accessed_at = @now`,
      )
      .run({ key: doc.key, rowJson, docJson, now });
    return !previous || previous.json !== rowJson || previous.doc_json !== docJson;
  }

  deleteIssue(key: string): boolean {
    return this.db.prepare(`DELETE FROM issues_cache WHERE key = ?`).run(key).changes > 0;
  }

  touchIssues(keys: readonly string[], now: number): void {
    if (keys.length === 0) return;
    const touch = this.db.prepare(`UPDATE issues_cache SET accessed_at = ? WHERE key = ?`);
    this.db.transaction(() => {
      for (const key of keys) touch.run(now, key);
    })();
  }

  /** Search cached rows by key prefix or summary words (for mentions). */
  findRows(query: string, limit: number): IssueRow[] {
    const trimmed = query.trim();
    if (trimmed === "") {
      return this.db
        .prepare<[number], { json: string }>(
          `SELECT json FROM issues_cache ORDER BY accessed_at DESC LIMIT ?`,
        )
        .all(limit)
        .map((found) => parseRow(found.json))
        .filter((row): row is IssueRow => row !== null);
    }
    const words = trimmed.toLowerCase().split(/\s+/).slice(0, 6);
    const candidates = this.db
      .prepare<[], { json: string }>(
        `SELECT json FROM issues_cache ORDER BY accessed_at DESC LIMIT 2000`,
      )
      .all();
    const out: IssueRow[] = [];
    const upper = trimmed.toUpperCase();
    for (const candidate of candidates) {
      const row = parseRow(candidate.json);
      if (!row) continue;
      const haystack = `${row.key} ${row.summary}`.toLowerCase();
      if (row.key.startsWith(upper) || words.every((word) => haystack.includes(word))) {
        out.push(row);
        if (out.length >= limit) break;
      }
    }
    // Exact and prefix key matches first.
    return out.sort((a, b) => Number(b.key === upper) - Number(a.key === upper));
  }

  // ------------------------------------------------------------ searches

  getSearch(queryId: string): CachedSearch | null {
    const found = this.db
      .prepare<
        [string],
        {
          query_id: string;
          jql: string;
          keys_json: string;
          has_more: number;
          fetched_limit: number;
          fetched_at: number;
        }
      >(
        `SELECT query_id, jql, keys_json, has_more, fetched_limit, fetched_at
         FROM search_cache WHERE query_id = ?`,
      )
      .get(queryId);
    if (!found) return null;
    let keys: string[] = [];
    try {
      const parsed: unknown = JSON.parse(found.keys_json);
      if (Array.isArray(parsed)) keys = parsed.filter((key): key is string => typeof key === "string");
    } catch {
      keys = [];
    }
    return {
      queryId: found.query_id,
      jql: found.jql,
      keys,
      hasMore: found.has_more === 1,
      fetchedLimit: found.fetched_limit,
      fetchedAt: found.fetched_at,
    };
  }

  /** Returns true when the ordered key list or has-more flag changed. */
  putSearch(search: CachedSearch, now: number): boolean {
    const previous = this.getSearch(search.queryId);
    this.db
      .prepare(
        `INSERT INTO search_cache (query_id, jql, keys_json, has_more, fetched_limit, fetched_at, accessed_at)
         VALUES (@queryId, @jql, @keys, @hasMore, @fetchedLimit, @fetchedAt, @now)
         ON CONFLICT (query_id) DO UPDATE SET jql = @jql, keys_json = @keys, has_more = @hasMore,
           fetched_limit = @fetchedLimit, fetched_at = @fetchedAt, accessed_at = @now`,
      )
      .run({
        queryId: search.queryId,
        jql: search.jql,
        keys: JSON.stringify(search.keys),
        hasMore: search.hasMore ? 1 : 0,
        fetchedLimit: search.fetchedLimit,
        fetchedAt: search.fetchedAt,
        now,
      });
    return (
      !previous ||
      previous.hasMore !== search.hasMore ||
      JSON.stringify(previous.keys) !== JSON.stringify(search.keys)
    );
  }

  touchSearch(queryId: string, now: number): void {
    this.db.prepare(`UPDATE search_cache SET accessed_at = ? WHERE query_id = ?`).run(now, queryId);
  }

  /** Remove a key from every cached search that holds it (it 404'd). */
  dropKeyFromSearches(key: string): string[] {
    const rows = this.db
      .prepare<[string], { query_id: string; keys_json: string }>(
        `SELECT query_id, keys_json FROM search_cache WHERE keys_json LIKE ?`,
      )
      .all(`%"${key}"%`);
    const update = this.db.prepare(`UPDATE search_cache SET keys_json = ? WHERE query_id = ?`);
    for (const row of rows) {
      const keys = (JSON.parse(row.keys_json) as string[]).filter((candidate) => candidate !== key);
      update.run(JSON.stringify(keys), row.query_id);
    }
    return rows.map((row) => row.query_id);
  }

  // ------------------------------------------------------------ bounds

  prune(): { issues: number; searches: number } {
    const searches = this.db
      .prepare(
        `DELETE FROM search_cache WHERE query_id IN (
           SELECT query_id FROM search_cache ORDER BY accessed_at DESC LIMIT -1 OFFSET ?
         )`,
      )
      .run(this.limits.maxSearches).changes;
    const issues = this.db
      .prepare(
        `DELETE FROM issues_cache WHERE key IN (
           SELECT key FROM issues_cache ORDER BY accessed_at DESC LIMIT -1 OFFSET ?
         )`,
      )
      .run(this.limits.maxIssues).changes;
    if (issues + searches > 0) this.db.pragma("incremental_vacuum");
    return { issues, searches };
  }

  stats(): { issues: number; documents: number; searches: number; limits: Limits } {
    const count = (sql: string) =>
      (this.db.prepare<[], { n: number }>(sql).get() ?? { n: 0 }).n;
    return {
      issues: count(`SELECT COUNT(*) AS n FROM issues_cache`),
      documents: count(`SELECT COUNT(*) AS n FROM issues_cache WHERE doc_json IS NOT NULL`),
      searches: count(`SELECT COUNT(*) AS n FROM search_cache`),
      limits: this.limits,
    };
  }

  /** Drop cached Jira data. Views and thread links stay. */
  clearCache(): void {
    this.db.exec(`DELETE FROM issues_cache; DELETE FROM search_cache;`);
    this.db.pragma("incremental_vacuum");
  }

  // ------------------------------------------------------------ meta

  getMeta(key: string): string | null {
    return (
      this.db
        .prepare<[string], { value: string }>(`SELECT value FROM meta WHERE key = ?`)
        .get(key)?.value ?? null
    );
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  // ------------------------------------------------------------ views

  /** Seed default views once. A user who deletes them does not get them back. */
  seedViews(now: number): void {
    if (this.getMeta("views_seeded") !== null) return;
    this.db.transaction(() => {
      DEFAULT_VIEWS.forEach((view, index) => {
        this.db
          .prepare(
            `INSERT OR IGNORE INTO views (id, name, jql, position, builtin, created_at, updated_at)
             VALUES (?, ?, ?, ?, 1, ?, ?)`,
          )
          .run(view.id, view.name, view.jql, index + 1, now, now);
      });
      this.setMeta("views_seeded", "1");
    })();
  }

  listViews(): View[] {
    return this.db
      .prepare<
        [],
        { id: string; name: string; jql: string; position: number; builtin: number }
      >(`SELECT id, name, jql, position, builtin FROM views ORDER BY position ASC, created_at ASC`)
      .all()
      .map((view) => ({ ...view, builtin: view.builtin === 1 }));
  }

  getView(id: string): View | null {
    return this.listViews().find((view) => view.id === id) ?? null;
  }

  /** Find by id, or by name ignoring case. */
  findView(idOrName: string): View | null {
    const needle = idOrName.trim().toLowerCase();
    const views = this.listViews();
    return (
      views.find((view) => view.id === idOrName) ??
      views.find((view) => view.name.toLowerCase() === needle) ??
      null
    );
  }

  createView(name: string, jql: string, now: number): View {
    const id = randomUUID().slice(0, 8);
    const last = this.db
      .prepare<[], { position: number | null }>(`SELECT MAX(position) AS position FROM views`)
      .get();
    const position = (last?.position ?? 0) + 1;
    this.db
      .prepare(
        `INSERT INTO views (id, name, jql, position, builtin, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(id, name, jql, position, now, now);
    return { id, name, jql, position, builtin: false };
  }

  updateView(id: string, patch: { name?: string; jql?: string }, now: number): View | null {
    const view = this.getView(id);
    if (!view) return null;
    const next = { ...view, ...patch };
    this.db
      .prepare(`UPDATE views SET name = ?, jql = ?, updated_at = ? WHERE id = ?`)
      .run(next.name, next.jql, now, id);
    return next;
  }

  deleteView(id: string): boolean {
    return this.db.prepare(`DELETE FROM views WHERE id = ?`).run(id).changes > 0;
  }

  /** Reorder: ids listed first in that order, any others keep relative order after. */
  reorderViews(ids: readonly string[], now: number): View[] {
    const views = this.listViews();
    const byId = new Map(views.map((view) => [view.id, view]));
    const ordered = [
      ...ids.filter((id) => byId.has(id)),
      ...views.map((view) => view.id).filter((id) => !ids.includes(id)),
    ];
    const update = this.db.prepare(`UPDATE views SET position = ?, updated_at = ? WHERE id = ?`);
    this.db.transaction(() => {
      ordered.forEach((id, index) => update.run(index + 1, now, id));
    })();
    return this.listViews();
  }

  // ------------------------------------------------------------ thread links

  linkThread(threadId: string, key: string, now: number): boolean {
    return (
      this.db
        .prepare(
          `INSERT OR IGNORE INTO thread_issues (thread_id, issue_key, created_at) VALUES (?, ?, ?)`,
        )
        .run(threadId, key, now).changes > 0
    );
  }

  unlinkThread(threadId: string, key: string): boolean {
    return (
      this.db
        .prepare(`DELETE FROM thread_issues WHERE thread_id = ? AND issue_key = ?`)
        .run(threadId, key).changes > 0
    );
  }

  threadIssueKeys(threadId: string): string[] {
    return this.db
      .prepare<[string], { issue_key: string }>(
        `SELECT issue_key FROM thread_issues WHERE thread_id = ? ORDER BY created_at ASC`,
      )
      .all(threadId)
      .map((row) => row.issue_key);
  }

  threadsForIssue(key: string): string[] {
    return this.db
      .prepare<[string], { thread_id: string }>(
        `SELECT thread_id FROM thread_issues WHERE issue_key = ? ORDER BY created_at ASC`,
      )
      .all(key)
      .map((row) => row.thread_id);
  }

  forgetThread(threadId: string): number {
    return this.db.prepare(`DELETE FROM thread_issues WHERE thread_id = ?`).run(threadId).changes;
  }
}
