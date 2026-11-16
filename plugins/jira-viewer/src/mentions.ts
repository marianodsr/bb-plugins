// Composer mentions: `@ENG-123` or `@words` offers Jira issues. Search runs
// inside bb's 2 s budget, so the cache answers first and Jira gets a short,
// bounded attempt; resolve attaches the issue as agent-only context.
import { isReady } from "./config.js";
import { MENTION_DOCUMENT_LIMITS, formatDocument, textQueryJql } from "./format.js";
import { ISSUE_KEY_PATTERN, type IssueRow } from "./schemas.js";
import type { JiraViewerService } from "./service.js";
import type { ResolvedConfig } from "./config.js";

export const MENTION_PROVIDER_ID = "issues";
const MAX_ITEMS = 8;
/** Leave headroom inside bb's 2 s mention time box. */
export const REMOTE_BUDGET_MS = 1_200;

function item(row: IssueRow) {
  return {
    id: row.key,
    title: `${row.key} ${row.summary}`.slice(0, 200),
    subtitle: [row.status, row.assignee?.displayName].filter(Boolean).join(", "),
  };
}

function withTimeout(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms).unref?.();
  return controller.signal;
}

export function buildMentionProvider(
  service: JiraViewerService,
  readConfig: () => Promise<ResolvedConfig>,
  remoteBudgetMs = REMOTE_BUDGET_MS,
) {
  return {
    id: MENTION_PROVIDER_ID,
    label: "Jira issues",
    async search({ query }: { query: string }) {
      const trimmed = query.trim();
      // Stay out of every `@` menu until the user has typed something.
      if (trimmed.length < 2) return [];
      if (!isReady(await readConfig())) return [];
      const local = service.findCachedRows(trimmed, MAX_ITEMS);
      const seen = new Set(local.map((row) => row.key));
      const results = [...local];
      if (results.length < MAX_ITEMS) {
        const signal = withTimeout(remoteBudgetMs);
        try {
          if (ISSUE_KEY_PATTERN.test(trimmed)) {
            const summary = await service.issueSummary(trimmed.toUpperCase(), signal);
            if (summary && !seen.has(summary.key)) {
              const row = service.findCachedRows(summary.key, 1)[0];
              if (row) results.unshift(row);
            }
          } else if (trimmed.length >= 3) {
            const remote = await service.searchFresh(
              { jql: textQueryJql(trimmed), limit: MAX_ITEMS },
              signal,
            );
            for (const row of remote.issues) {
              if (!seen.has(row.key)) results.push(row);
            }
          }
        } catch {
          // Slow or failing Jira never breaks the menu; the cache answer stands.
        }
      }
      return results.slice(0, MAX_ITEMS).map(item);
    },
    async resolve(itemId: string) {
      const key = itemId.toUpperCase();
      try {
        const { doc, fromCache } = await service.issueForReading(key, withTimeout(8_000));
        const note = fromCache ? "(Cached copy; Jira could not be reached.)\n\n" : "";
        return {
          context: `The user mentioned Jira issue ${doc.key}.\n\n${note}${formatDocument(doc, MENTION_DOCUMENT_LIMITS)}`,
        };
      } catch (error) {
        // Never block the send: give the agent what we know.
        const message = error instanceof Error ? error.message : String(error);
        return {
          context: `The user mentioned Jira issue ${key}, but it could not be loaded: ${message}`,
        };
      }
    },
  };
}
