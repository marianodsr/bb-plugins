// Plugin SQLite: comments, replies, and the file snapshots anchoring diffs against.
import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  Comment,
  CommentCounts,
  CommentState,
  Reply,
  Severity,
} from "./contract";

/** Append-only: never edit or reorder a shipped statement. */
export const MIGRATIONS = [
  `CREATE TABLE comments (
    id TEXT PRIMARY KEY,
    environment_id TEXT NOT NULL,
    thread_id TEXT,
    path TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    snippet TEXT NOT NULL,
    file_sha TEXT NOT NULL,
    body TEXT NOT NULL,
    severity TEXT NOT NULL,
    state TEXT NOT NULL,
    sent_thread_id TEXT,
    sent_at INTEGER,
    resolved_at INTEGER,
    resolved_by TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX comments_env_path ON comments (environment_id, path)`,
  `CREATE INDEX comments_sent_thread ON comments (sent_thread_id)`,
  `CREATE TABLE replies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    comment_id TEXT NOT NULL,
    author TEXT NOT NULL,
    author_thread_id TEXT,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX replies_comment ON replies (comment_id)`,
  `CREATE TABLE file_snapshots (
    sha256 TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  // An agent's resolution waits here until the reviewer acknowledges it.
  `ALTER TABLE comments ADD COLUMN acknowledged_at INTEGER`,
];

/** Snapshots larger than this are not kept; anchoring falls back to searching. */
export const MAX_SNAPSHOT_BYTES = 2_000_000;

interface CommentRow {
  id: string;
  environment_id: string;
  thread_id: string | null;
  path: string;
  start_line: number;
  end_line: number;
  snippet: string;
  file_sha: string;
  body: string;
  severity: string;
  state: string;
  sent_thread_id: string | null;
  sent_at: number | null;
  resolved_at: number | null;
  resolved_by: string | null;
  acknowledged_at: number | null;
  created_at: number;
  updated_at: number;
}

interface ReplyRow {
  id: number;
  comment_id: string;
  author: string;
  author_thread_id: string | null;
  body: string;
  created_at: number;
}

export interface NewComment {
  id?: string;
  environmentId: string;
  threadId: string | null;
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
  fileSha256: string;
  body: string;
  severity: Severity;
}

export interface CommentFilter {
  environmentId?: string;
  path?: string;
  sentThreadId?: string;
  states?: readonly CommentState[];
  ids?: readonly string[];
}

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function newCommentId(): string {
  const bytes = randomBytes(10);
  let id = "rc_";
  for (const byte of bytes) id += ID_ALPHABET[byte % ID_ALPHABET.length];
  return id;
}

function toReply(row: ReplyRow): Reply {
  return {
    id: row.id,
    author: row.author === "agent" ? "agent" : "user",
    threadId: row.author_thread_id,
    body: row.body,
    createdAt: row.created_at,
  };
}

export class Store {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number = Date.now,
  ) {}

  private toComment(row: CommentRow, replies: Reply[]): Comment {
    return {
      id: row.id,
      environmentId: row.environment_id,
      threadId: row.thread_id,
      path: row.path,
      startLine: row.start_line,
      endLine: row.end_line,
      snippet: row.snippet,
      fileSha256: row.file_sha,
      body: row.body,
      severity: row.severity as Severity,
      state: row.state as CommentState,
      sentThreadId: row.sent_thread_id,
      sentAt: row.sent_at,
      resolvedAt: row.resolved_at,
      resolvedBy: row.resolved_by === null ? null : row.resolved_by === "agent" ? "agent" : "user",
      acknowledgedAt: row.acknowledged_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      replies,
    };
  }

  private withReplies(rows: CommentRow[]): Comment[] {
    if (rows.length === 0) return [];
    const byComment = new Map<string, Reply[]>();
    // Chunk to stay under SQLite's bound-parameter limit.
    for (let i = 0; i < rows.length; i += 500) {
      const ids = rows.slice(i, i + 500).map((row) => row.id);
      const replies = this.db
        .prepare(
          `SELECT * FROM replies WHERE comment_id IN (${ids.map(() => "?").join(",")}) ORDER BY id`,
        )
        .all(...ids) as ReplyRow[];
      for (const reply of replies) {
        const list = byComment.get(reply.comment_id) ?? [];
        list.push(toReply(reply));
        byComment.set(reply.comment_id, list);
      }
    }
    return rows.map((row) => this.toComment(row, byComment.get(row.id) ?? []));
  }

  get(id: string): Comment | null {
    const row = this.db.prepare(`SELECT * FROM comments WHERE id = ?`).get(id) as
      | CommentRow
      | undefined;
    return row === undefined ? null : this.withReplies([row])[0]!;
  }

  list(filter: CommentFilter): Comment[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.environmentId !== undefined) {
      where.push("environment_id = ?");
      params.push(filter.environmentId);
    }
    if (filter.path !== undefined) {
      where.push("path = ?");
      params.push(filter.path);
    }
    if (filter.sentThreadId !== undefined) {
      where.push("sent_thread_id = ?");
      params.push(filter.sentThreadId);
    }
    if (filter.states !== undefined && filter.states.length > 0) {
      where.push(`state IN (${filter.states.map(() => "?").join(",")})`);
      params.push(...filter.states);
    }
    if (filter.ids !== undefined) {
      if (filter.ids.length === 0) return [];
      where.push(`id IN (${filter.ids.map(() => "?").join(",")})`);
      params.push(...filter.ids);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM comments ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY environment_id, path, start_line, created_at`,
      )
      .all(...params) as CommentRow[];
    return this.withReplies(rows);
  }

  create(input: NewComment): Comment {
    const id = input.id ?? newCommentId();
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO comments (id, environment_id, thread_id, path, start_line, end_line, snippet,
           file_sha, body, severity, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      )
      .run(
        id,
        input.environmentId,
        input.threadId,
        input.path,
        input.startLine,
        input.endLine,
        input.snippet,
        input.fileSha256,
        input.body,
        input.severity,
        now,
        now,
      );
    return this.get(id)!;
  }

  update(id: string, patch: { body?: string; severity?: Severity }): Comment | null {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.body !== undefined) {
      sets.push("body = ?");
      params.push(patch.body);
    }
    if (patch.severity !== undefined) {
      sets.push("severity = ?");
      params.push(patch.severity);
    }
    if (sets.length > 0) {
      sets.push("updated_at = ?");
      params.push(this.now(), id);
      this.db.prepare(`UPDATE comments SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    }
    return this.get(id);
  }

  delete(id: string): boolean {
    return this.db.transaction(() => {
      this.db.prepare(`DELETE FROM replies WHERE comment_id = ?`).run(id);
      const deleted = this.db.prepare(`DELETE FROM comments WHERE id = ?`).run(id).changes > 0;
      this.collectSnapshots();
      return deleted;
    })();
  }

  /** A user's resolution is acknowledged at once; an agent's waits for the reviewer. */
  resolve(id: string, by: "user" | "agent"): Comment | null {
    const now = this.now();
    this.db
      .prepare(
        `UPDATE comments SET state = 'resolved', resolved_at = ?, resolved_by = ?, acknowledged_at = ?,
           updated_at = ? WHERE id = ?`,
      )
      .run(now, by, by === "user" ? now : null, now, id);
    return this.get(id);
  }

  /** The reviewer has seen these agent resolutions. Returns the ids that changed. */
  acknowledge(ids: readonly string[]): string[] {
    const now = this.now();
    const statement = this.db.prepare(
      `UPDATE comments SET acknowledged_at = ?, updated_at = ?
       WHERE id = ? AND state = 'resolved' AND acknowledged_at IS NULL`,
    );
    return this.db.transaction(() => ids.filter((id) => statement.run(now, now, id).changes > 0))();
  }

  /** Reopen a resolved comment: back to sent if it was handed to a thread. */
  reopen(id: string): Comment | null {
    this.db
      .prepare(
        `UPDATE comments
         SET state = CASE WHEN sent_thread_id IS NULL THEN 'open' ELSE 'sent' END,
             resolved_at = NULL, resolved_by = NULL, acknowledged_at = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(this.now(), id);
    return this.get(id);
  }

  /** Hand comments to a thread. Resolved and outdated comments keep their state. */
  markSent(ids: readonly string[], threadId: string): void {
    const now = this.now();
    const statement = this.db.prepare(
      `UPDATE comments
       SET sent_thread_id = ?, sent_at = ?, updated_at = ?,
           state = CASE WHEN state = 'open' THEN 'sent' ELSE state END
       WHERE id = ?`,
    );
    this.db.transaction(() => {
      for (const id of ids) statement.run(threadId, now, now, id);
    })();
  }

  addReply(commentId: string, author: "user" | "agent", body: string, threadId: string | null): void {
    const now = this.now();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO replies (comment_id, author, author_thread_id, body, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(commentId, author, threadId, body, now);
      this.db.prepare(`UPDATE comments SET updated_at = ? WHERE id = ?`).run(now, commentId);
    })();
  }

  /** Comments on one file whose anchor was computed against different content. */
  staleAnchors(environmentId: string, path: string, sha256: string): Comment[] {
    const rows = this.db
      .prepare(`SELECT * FROM comments WHERE environment_id = ? AND path = ? AND file_sha != ?`)
      .all(environmentId, path, sha256) as CommentRow[];
    return this.withReplies(rows);
  }

  setAnchor(
    id: string,
    anchor: { startLine: number; endLine: number; snippet: string; fileSha256: string; state: CommentState },
  ): void {
    this.db
      .prepare(
        `UPDATE comments SET start_line = ?, end_line = ?, snippet = ?, file_sha = ?, state = ?,
           updated_at = ? WHERE id = ?`,
      )
      .run(anchor.startLine, anchor.endLine, anchor.snippet, anchor.fileSha256, anchor.state, this.now(), id);
  }

  setState(id: string, state: CommentState): void {
    this.db.prepare(`UPDATE comments SET state = ?, updated_at = ? WHERE id = ?`).run(state, this.now(), id);
  }

  saveSnapshot(sha256: string, content: string): void {
    if (Buffer.byteLength(content, "utf8") > MAX_SNAPSHOT_BYTES) return;
    this.db
      .prepare(`INSERT OR IGNORE INTO file_snapshots (sha256, content, created_at) VALUES (?, ?, ?)`)
      .run(sha256, content, this.now());
  }

  snapshot(sha256: string): string | null {
    const row = this.db.prepare(`SELECT content FROM file_snapshots WHERE sha256 = ?`).get(sha256) as
      | { content: string }
      | undefined;
    return row?.content ?? null;
  }

  /** Drop snapshots no comment anchors against any more. */
  collectSnapshots(): void {
    this.db
      .prepare(`DELETE FROM file_snapshots WHERE sha256 NOT IN (SELECT DISTINCT file_sha FROM comments)`)
      .run();
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  countsByPath(environmentId: string): Map<string, CommentCounts> {
    const rows = this.db
      .prepare(
        `SELECT path, state, COUNT(*) AS n FROM comments WHERE environment_id = ? GROUP BY path, state`,
      )
      .all(environmentId) as { path: string; state: string; n: number }[];
    const counts = new Map<string, CommentCounts>();
    for (const row of rows) {
      const entry = counts.get(row.path) ?? { open: 0, sent: 0, resolved: 0, outdated: 0 };
      if (row.state in entry) entry[row.state as keyof CommentCounts] = row.n;
      counts.set(row.path, entry);
    }
    return counts;
  }

  /** Unresolved comments handed to a thread (sent, or sent then outdated). */
  unresolvedSentCount(threadId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM comments WHERE sent_thread_id = ? AND state IN ('sent', 'outdated')`,
      )
      .get(threadId) as { n: number };
    return row.n;
  }

  /** How many of these ids exist, are unresolved, and were not sent to another thread. */
  unresolvedCount(ids: readonly string[], threadId: string): number {
    if (ids.length === 0) return 0;
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM comments WHERE id IN (${ids.map(() => "?").join(",")})
         AND state IN ('open', 'sent', 'outdated')
         AND (sent_thread_id IS NULL OR sent_thread_id = ?)`,
      )
      .get(...ids, threadId) as { n: number };
    return row.n;
  }
}
