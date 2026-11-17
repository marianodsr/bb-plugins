// Plugin SQLite: explicit bindings, composer drafts waiting for their thread,
// and Helix comments kept here when Review Editor is not installed.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

type Database = ReturnType<BbPluginApi["storage"]["database"]>;

export const MIGRATIONS = [
  `CREATE TABLE bindings (
     host_id TEXT NOT NULL,
     pid INTEGER NOT NULL,
     started_at TEXT NOT NULL,
     thread_id TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (host_id, pid, started_at)
   )`,
  `CREATE TABLE drafts (
     id TEXT PRIMARY KEY,
     thread_id TEXT NOT NULL,
     text TEXT NOT NULL,
     summary TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX drafts_thread ON drafts (thread_id, created_at)`,
  `CREATE TABLE comments (
     id TEXT PRIMARY KEY,
     thread_id TEXT NOT NULL,
     path TEXT NOT NULL,
     language_id TEXT NOT NULL,
     start_line INTEGER NOT NULL,
     end_line INTEGER NOT NULL,
     snippet TEXT NOT NULL,
     body TEXT NOT NULL,
     modified INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     sent_at INTEGER
   )`,
  `CREATE INDEX comments_thread ON comments (thread_id, sent_at)`,
];

export interface Draft {
  id: string;
  threadId: string;
  text: string;
  summary: string;
  createdAt: number;
}

export interface LocalComment {
  id: string;
  threadId: string;
  path: string;
  languageId: string;
  startLine: number;
  endLine: number;
  snippet: string;
  body: string;
  modified: boolean;
  createdAt: number;
  sentAt: number | null;
}

const MAX_DRAFTS_PER_THREAD = 20;

export class Store {
  constructor(private readonly db: Database) {}

  binding(hostId: string, pid: number, startedAt: string): string | null {
    const row = this.db.prepare(`SELECT thread_id FROM bindings WHERE host_id = ? AND pid = ? AND started_at = ?`).get(hostId, pid, startedAt) as { thread_id: string } | undefined;
    return row?.thread_id ?? null;
  }

  bind(hostId: string, pid: number, startedAt: string, threadId: string): void {
    this.db
      .prepare(`INSERT INTO bindings (host_id, pid, started_at, thread_id, created_at) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT (host_id, pid, started_at) DO UPDATE SET thread_id = excluded.thread_id, created_at = excluded.created_at`)
      .run(hostId, pid, startedAt, threadId, Date.now());
  }

  unbind(hostId: string, pid: number, startedAt: string): boolean {
    return this.db.prepare(`DELETE FROM bindings WHERE host_id = ? AND pid = ? AND started_at = ?`).run(hostId, pid, startedAt).changes > 0;
  }

  /** Forget bindings of instances that are gone (keep the current ones). */
  pruneBindings(hostId: string, live: { pid: number; startedAt: string }[]): void {
    const rows = this.db.prepare(`SELECT pid, started_at FROM bindings WHERE host_id = ?`).all(hostId) as { pid: number; started_at: string }[];
    const keep = new Set(live.map((l) => `${l.pid}\0${l.startedAt}`));
    const del = this.db.prepare(`DELETE FROM bindings WHERE host_id = ? AND pid = ? AND started_at = ?`);
    for (const row of rows) if (!keep.has(`${row.pid}\0${row.started_at}`)) del.run(hostId, row.pid, row.started_at);
  }

  addDraft(draft: Draft): void {
    this.db.prepare(`INSERT INTO drafts (id, thread_id, text, summary, created_at) VALUES (?, ?, ?, ?, ?)`).run(draft.id, draft.threadId, draft.text, draft.summary, draft.createdAt);
    // Keep the queue bounded: drop the oldest beyond the cap.
    this.db
      .prepare(`DELETE FROM drafts WHERE thread_id = ? AND id NOT IN (SELECT id FROM drafts WHERE thread_id = ? ORDER BY created_at DESC LIMIT ?)`)
      .run(draft.threadId, draft.threadId, MAX_DRAFTS_PER_THREAD);
  }

  drafts(threadId: string): Draft[] {
    const rows = this.db.prepare(`SELECT id, thread_id, text, summary, created_at FROM drafts WHERE thread_id = ? ORDER BY created_at`).all(threadId) as { id: string; thread_id: string; text: string; summary: string; created_at: number }[];
    return rows.map((r) => ({ id: r.id, threadId: r.thread_id, text: r.text, summary: r.summary, createdAt: r.created_at }));
  }

  draftThreads(): string[] {
    return (this.db.prepare(`SELECT DISTINCT thread_id FROM drafts`).all() as { thread_id: string }[]).map((r) => r.thread_id);
  }

  takeDraft(id: string): boolean {
    return this.db.prepare(`DELETE FROM drafts WHERE id = ?`).run(id).changes > 0;
  }

  addComment(comment: LocalComment): void {
    this.db
      .prepare(`INSERT INTO comments (id, thread_id, path, language_id, start_line, end_line, snippet, body, modified, created_at, sent_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
      .run(comment.id, comment.threadId, comment.path, comment.languageId, comment.startLine, comment.endLine, comment.snippet, comment.body, comment.modified ? 1 : 0, comment.createdAt);
  }

  pendingComments(threadId: string): LocalComment[] {
    const rows = this.db.prepare(`SELECT * FROM comments WHERE thread_id = ? AND sent_at IS NULL ORDER BY path, start_line`).all(threadId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      threadId: String(r.thread_id),
      path: String(r.path),
      languageId: String(r.language_id),
      startLine: Number(r.start_line),
      endLine: Number(r.end_line),
      snippet: String(r.snippet),
      body: String(r.body),
      modified: Number(r.modified) === 1,
      createdAt: Number(r.created_at),
      sentAt: null,
    }));
  }

  markCommentsSent(ids: readonly string[]): void {
    const stmt = this.db.prepare(`UPDATE comments SET sent_at = ? WHERE id = ?`);
    const now = Date.now();
    for (const id of ids) stmt.run(now, id);
  }
}
