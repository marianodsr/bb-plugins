// The issue as a document: key and Open in Jira, title, a quiet metadata
// line, the description as prose, then subtasks, links, attachments and
// comments. The footer holds the handoff (Send to thread, T) and Add to
// Task Board (A).
import { Markdown, UrlLink, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import {
  Collapse,
  EmptyState,
  HandoffSheet,
  Kbd,
  SentChip,
  Skeleton,
  Tint,
  hueFor,
  shortcutLabel,
  useHandoff,
  useHotkeys,
} from "../kit";
import { formatDocument } from "../src/format";
import type { IssueDocument as Doc, Failure, IssueRow } from "../src/schemas";
import { failureCopy, shortAge } from "./logic";
import { IssueKey, RefRow, SectionHeading, StatusTint } from "./parts";
import { useAddToTaskBoard, useIssue, useNow, useStatus, useThreadLink } from "./rpc";

/** Comments shown before "Show earlier comments". */
export const VISIBLE_COMMENTS = 5;

export function buildIssuePrompt(doc: Doc): string {
  return [
    formatDocument(doc, { maxDescriptionChars: 8_000, maxComments: 5, maxCommentChars: 1_500, includeComments: true }),
    `Jira Viewer has this issue: call jira_viewer_get_issue with key ${doc.key} for the latest version.`,
  ].join("\n\n");
}

export function IssueDocument({
  issueKey,
  onOpenIssue,
  onClose,
  closeLabel = "Back to list",
  showBackBar = true,
  currentThreadId = null,
  projectId = null,
  hotkeysEnabled = true,
}: {
  issueKey: string;
  /** False in a split layout: Escape still closes, without the bar. */
  showBackBar?: boolean;
  onOpenIssue: (key: string) => void;
  /** Shown as a back control when the document replaces the list. */
  onClose?: () => void;
  closeLabel?: string;
  currentThreadId?: string | null;
  projectId?: string | null;
  hotkeysEnabled?: boolean;
}) {
  const query = useIssue(issueKey);
  const result = query.data && query.data.key === issueKey ? query.data : undefined;
  const doc = result?.issue ?? null;
  const row = doc ?? result?.row ?? null;
  const failure = result?.error ?? null;
  const now = useNow();

  if (!row && (query.isLoading || result?.refreshing || result === undefined)) {
    return <DocumentSkeleton issueKey={issueKey} onClose={showBackBar ? onClose : undefined} closeLabel={closeLabel} />;
  }
  if (!row) {
    const copy = failure ? failureCopy(failure) : null;
    return (
      <div className="flex flex-col">
        {onClose && showBackBar ? <BackBar onClose={onClose} label={closeLabel} /> : null}
        <EmptyState
          tone={failure?.kind === "not_found" ? "neutral" : "error"}
          icon={failure?.kind === "not_found" ? "Search" : "AlertCircle"}
          title={failure?.kind === "not_found" ? `${issueKey} is not in Jira` : (copy?.title ?? `Could not load ${issueKey}`)}
          description={copy?.description ?? "Try again."}
          action={
            failure?.kind !== "not_found" ? (
              <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
                Try again
              </Button>
            ) : undefined
          }
        />
      </div>
    );
  }
  return (
    <LoadedDocument
      row={row}
      doc={doc}
      stale={Boolean(result?.refreshing)}
      failure={failure}
      now={now}
      onOpenIssue={onOpenIssue}
      onClose={onClose}
      closeLabel={closeLabel}
      showBackBar={showBackBar}
      currentThreadId={currentThreadId}
      projectId={projectId}
      hotkeysEnabled={hotkeysEnabled}
    />
  );
}

function BackBar({ onClose, label }: { onClose: () => void; label: string }) {
  return (
    <div className="flex h-10 shrink-0 items-center px-2">
      <Button size="sm" variant="ghost" onClick={onClose} aria-keyshortcuts="Escape" className="gap-1.5 px-2 text-muted-foreground">
        {label}
        <Kbd>Esc</Kbd>
      </Button>
    </div>
  );
}

function LoadedDocument({
  row,
  doc,
  stale,
  failure,
  now,
  onOpenIssue,
  onClose,
  closeLabel,
  showBackBar,
  currentThreadId,
  projectId,
  hotkeysEnabled,
}: {
  showBackBar: boolean;
  row: IssueRow;
  doc: Doc | null;
  stale: boolean;
  failure: Failure | null;
  now: number;
  onOpenIssue: (key: string) => void;
  onClose?: () => void;
  closeLabel: string;
  currentThreadId: string | null;
  projectId: string | null;
  hotkeysEnabled: boolean;
}) {
  const navigate = useBbNavigate();
  const status = useStatus();
  const link = useThreadLink();
  const addToBoard = useAddToTaskBoard();
  const [boardTask, setBoardTask] = useState<{ key: string; route: string | null } | null>(null);
  const items = useMemo(() => (doc ? [doc] : []), [doc]);

  const handoff = useHandoff<Doc>({
    items,
    getKey: (issue) => issue.key,
    buildPrompt: (issues) => issues.map(buildIssuePrompt).join("\n\n---\n\n"),
    pluginMetadata: (issues) => ({ jiraIssueKeys: issues.map((issue) => issue.key) }),
    noun: { one: "issue", many: "issues" },
    currentThreadId,
    projectId,
    newThreadTitle: (issues) => (issues[0] ? `${issues[0].key} ${issues[0].summary}`.slice(0, 120) : undefined),
    onSent: async (sent, issues) => {
      await Promise.all(issues.map((issue) => link.mutate({ threadId: sent.threadId, key: issue.key })));
    },
    hotkey: hotkeysEnabled ? "t" : undefined,
  });

  const taskBoard = status.data?.integrations.taskBoard === true;
  const added = boardTask?.key === row.key ? boardTask : null;
  const addToTaskBoard = async () => {
    if (!taskBoard || added) return;
    // Optimistic: the chip shows at once and goes away if Task Board refuses.
    setBoardTask({ key: row.key, route: null });
    try {
      const created = await addToBoard.mutate({ key: row.key, ...(projectId ? { projectId } : {}) });
      setBoardTask({ key: row.key, route: created.route });
      // Task Board returns the existing task for a key it already has.
      toast.success(`${row.key} is on Task Board`);
    } catch (error) {
      setBoardTask(null);
      toast.error(`Not added to Task Board: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  useHotkeys(
    [
      { key: "o", handler: () => void navigate.openUrl(row.url), description: "Open in Jira", group: "Issue" },
      ...(taskBoard
        ? [{ key: "a", handler: () => void addToTaskBoard(), description: "Add to Task Board", group: "Issue" }]
        : []),
      ...(onClose ? [{ key: "Escape", handler: onClose, description: closeLabel, group: "Issue" }] : []),
    ],
    { enabled: hotkeysEnabled },
  );

  return (
    <article className="flex min-h-0 flex-1 flex-col" aria-label={`${row.key} ${row.summary}`}>
      {onClose && showBackBar ? <BackBar onClose={onClose} label={closeLabel} /> : null}
      <div className="min-h-0 flex-1 overflow-y-auto" data-issue-doc-scroll>
        <div className={cn("mx-auto flex w-full max-w-[46rem] flex-col gap-6 px-5 pb-8", onClose && showBackBar ? "pt-2" : "pt-5")}>
          <header ref={handoff.itemRef(row.key)} className="flex flex-col gap-2 rounded-lg">
            <div className="flex items-center gap-3 text-sm">
              <IssueKey>{row.key}</IssueKey>
              {row.issueType ? <span className="text-xs text-muted-foreground">{row.issueType}</span> : null}
              <span className="flex-1" />
              <UrlLink
                href={row.url}
                title={hotkeysEnabled ? `Open in Jira (${shortcutLabel("o")})` : "Open in Jira"}
                className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-sm text-muted-foreground outline-none transition-colors duration-[120ms] hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
              >
                Open in Jira {hotkeysEnabled ? <Kbd>O</Kbd> : null}
              </UrlLink>
            </div>
            <h1 className="text-xl font-semibold tracking-tight text-foreground">{row.summary || "Untitled"}</h1>
            <MetaLine row={row} doc={doc} now={now} />
            {failure && doc ? <StaleNote failure={failure} /> : null}
          </header>

          {doc ? <DocumentBody doc={doc} onOpenIssue={onOpenIssue} /> : <BodySkeleton />}
        </div>
      </div>
      <footer className="flex h-12 shrink-0 items-center gap-2 border-t border-border/60 px-4">
        <SentChip result={handoff.lastResult} />
        {added ? (
          added.route ? (
            <UrlLink href={added.route} className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
              On Task Board
            </UrlLink>
          ) : (
            <span className="text-xs text-muted-foreground">Adding to Task Board</span>
          )
        ) : null}
        <span className="flex-1" />
        {stale ? <span className="sr-only">Refreshing</span> : null}
        {taskBoard ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={added !== null}
            onClick={() => void addToTaskBoard()}
            aria-keyshortcuts={hotkeysEnabled ? "a" : undefined}
            className="gap-1.5"
          >
            Add to Task Board {hotkeysEnabled ? <Kbd>A</Kbd> : null}
          </Button>
        ) : null}
        <HandoffSheet handoff={handoff} />
      </footer>
    </article>
  );
}

function MetaLine({ row, doc, now }: { row: IssueRow; doc: Doc | null; now: number }) {
  const parts: ReactNode[] = [
    <StatusTint key="status" status={row.status} category={row.statusCategory} />,
    <span key="assignee" className={row.assignee ? "text-foreground/80" : "text-muted-foreground"}>
      {row.assignee?.displayName ?? "Unassigned"}
    </span>,
  ];
  if (row.priority) parts.push(<span key="priority">{row.priority}</span>);
  if (doc?.dueDate) parts.push(<span key="due">Due {doc.dueDate}</span>);
  if (row.updated) {
    parts.push(
      <span key="updated" className="tabular-nums" title={row.updated}>
        Updated {shortAge(row.updated, now)}
        {shortAge(row.updated, now) === "now" ? "" : " ago"}
      </span>,
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">{parts}</div>
      {row.labels.length > 0 || (doc?.components.length ?? 0) > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {row.labels.map((label) => (
            <Tint key={label} hue={hueFor(label)}>
              {label}
            </Tint>
          ))}
          {doc?.components.map((component) => (
            <span key={component} className="rounded-md border border-border/60 px-1.5 text-xs leading-5 text-muted-foreground">
              {component}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function StaleNote({ failure }: { failure: Failure }) {
  const copy = failureCopy(failure);
  return (
    <p role="status" className="text-xs text-warning-text">
      Showing the cached copy. {copy.title}.
    </p>
  );
}

function DocumentBody({ doc, onOpenIssue }: { doc: Doc; onOpenIssue: (key: string) => void }) {
  const [showAllComments, setShowAllComments] = useState(false);
  const doneSubtasks = doc.subtasks.filter((task) => task.statusCategory === "done").length;
  const earlier = doc.comments.slice(0, Math.max(0, doc.comments.length - VISIBLE_COMMENTS));
  const latest = doc.comments.slice(-VISIBLE_COMMENTS);
  const linkGroups = groupLinks(doc);

  return (
    <>
      <section aria-label="Description" className="max-w-[72ch] text-sm leading-6 text-foreground">
        {doc.description.trim() === "" ? (
          <p className="text-muted-foreground">No description.</p>
        ) : (
          <Markdown content={doc.description} />
        )}
      </section>

      {doc.parent ? (
        <section className="flex flex-col gap-1">
          <SectionHeading>Parent</SectionHeading>
          <RefRow issue={doc.parent} onOpen={onOpenIssue} />
        </section>
      ) : null}

      {doc.subtasks.length > 0 ? (
        <section className="flex flex-col gap-1">
          <SectionHeading count={`${doneSubtasks} of ${doc.subtasks.length} done`}>Subtasks</SectionHeading>
          <div className="flex flex-col">
            {doc.subtasks.map((task) => (
              <RefRow key={task.key} issue={task} onOpen={onOpenIssue} />
            ))}
          </div>
        </section>
      ) : null}

      {linkGroups.length > 0 ? (
        <section className="flex flex-col gap-1">
          <SectionHeading count={doc.links.length}>Links</SectionHeading>
          <div className="flex flex-col">
            {linkGroups.flatMap(([label, links]) =>
              links.map((entry, index) => (
                <RefRow key={entry.id + entry.issue.key} issue={entry.issue} label={index === 0 ? label : ""} onOpen={onOpenIssue} />
              )),
            )}
          </div>
        </section>
      ) : null}

      {doc.attachments.length > 0 ? (
        <section className="flex flex-col gap-1">
          <SectionHeading count={doc.attachments.length}>Attachments</SectionHeading>
          <ul className="flex flex-col">
            {doc.attachments.map((file) => (
              <li key={file.id} className="flex h-8 items-center gap-3 px-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{file.filename}</span>
                <span className="text-xs tabular-nums text-muted-foreground">{formatSize(file.size)}</span>
              </li>
            ))}
          </ul>
          <p className="px-2 text-xs text-muted-foreground">Attachments open in Jira.</p>
        </section>
      ) : null}

      <section className="flex flex-col gap-3" aria-label="Comments">
        <SectionHeading count={doc.commentsTotal}>Comments</SectionHeading>
        {doc.commentsTotal === 0 ? <p className="text-sm text-muted-foreground">No comments yet.</p> : null}
        {doc.commentsTotal > doc.comments.length ? (
          <p className="text-xs text-muted-foreground">
            The {doc.commentsTotal - doc.comments.length} oldest are only in Jira.
          </p>
        ) : null}
        {earlier.length > 0 ? (
          <div className="flex flex-col">
            <Button
              size="sm"
              variant="ghost"
              className="self-start px-2 text-muted-foreground"
              aria-expanded={showAllComments}
              onClick={() => setShowAllComments((open) => !open)}
            >
              {showAllComments ? "Hide earlier comments" : `Show ${earlier.length} earlier comments`}
            </Button>
            <Collapse open={showAllComments}>
              <div className="flex flex-col gap-4 pt-3">
                {earlier.map((comment) => (
                  <CommentView key={comment.id} comment={comment} />
                ))}
              </div>
            </Collapse>
          </div>
        ) : null}
        <div className="flex flex-col gap-4">
          {latest.map((comment) => (
            <CommentView key={comment.id} comment={comment} />
          ))}
        </div>
      </section>
    </>
  );
}

function CommentView({ comment }: { comment: Doc["comments"][number] }) {
  return (
    <div className="flex max-w-[72ch] flex-col gap-1">
      <div className="flex items-baseline gap-2 text-xs">
        <span className="font-medium text-foreground">{comment.author?.displayName ?? "Someone"}</span>
        {comment.created ? (
          <time className="tabular-nums text-muted-foreground" dateTime={comment.created} title={comment.created}>
            {formatDate(comment.created)}
          </time>
        ) : null}
      </div>
      <div className="text-sm leading-6">
        {comment.body.trim() === "" ? <p className="text-muted-foreground">Empty comment.</p> : <Markdown content={comment.body} />}
      </div>
    </div>
  );
}

function groupLinks(doc: Doc): [string, Doc["links"]][] {
  const groups = new Map<string, Doc["links"]>();
  for (const entry of doc.links) {
    const label = entry.label.charAt(0).toUpperCase() + entry.label.slice(1);
    groups.set(label, [...(groups.get(label) ?? []), entry]);
  }
  return [...groups.entries()];
}

function formatSize(size: number | null): string {
  if (size === null) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Matches the loaded layout: key row, title, meta line, prose. */
export function DocumentSkeleton({
  issueKey,
  onClose,
  closeLabel = "Back to list",
}: {
  issueKey?: string;
  onClose?: () => void;
  closeLabel?: string;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" role="status" aria-label="Loading issue">
      {onClose ? <BackBar onClose={onClose} label={closeLabel} /> : null}
      <div className="mx-auto flex w-full max-w-[46rem] flex-col gap-6 px-5 pt-5">
        <div className="flex flex-col gap-2">
          <div className="flex h-5 items-center">
            {issueKey ? <IssueKey className="text-sm">{issueKey}</IssueKey> : <Skeleton className="h-3 w-16" />}
          </div>
          <Skeleton className="h-6 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
        </div>
        <BodySkeleton />
      </div>
    </div>
  );
}

function BodySkeleton() {
  return (
    <div className="flex max-w-[72ch] flex-col gap-2.5" aria-hidden>
      {["w-full", "w-11/12", "w-full", "w-4/5", "w-2/3"].map((width, index) => (
        <Skeleton key={index} className={`h-3.5 ${width}`} />
      ))}
    </div>
  );
}
