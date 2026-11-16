// The Jira Viewer page: search and the issue list, with the open issue
// beside it on wide containers or in its place on narrow ones.
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "../components/ui/button";
import { Icon } from "../components/ui/icon";
import {
  EmptyState,
  Kbd,
  ProgressLine,
  ShortcutSheet,
  SkeletonRows,
  isTypingTarget,
  useContainerWidth,
  useHotkeys,
} from "../kit";
import { cn } from "../lib/utils";
import { LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX } from "../src/contract";
import type { Failure } from "../src/schemas";
import { DocumentSkeleton, IssueDocument } from "./IssueDocument";
import { IssueList, PAGE_STEP } from "./IssueList";
import {
  DEFAULT_SOURCE,
  classifySearch,
  failureCopy,
  formatSubPath,
  groupIssues,
  moveSelection,
  parseSubPath,
  reconcileSelection,
  visualOrder,
  type ListSource,
} from "./logic";
import { PANEL_PATH, useIssueList, useLastSource, useNow, useRefresh, useStatus, useViewMutations, useViews } from "./rpc";
import { ConnectionError, SetupState } from "./SetupState";

/** Container width at which the issue opens beside the list. */
export const SPLIT_MIN_WIDTH = 900;

const BLOCKING_KINDS = new Set<Failure["kind"]>(["unauthorized", "invalid_response"]);

export function IssuesPage({ subPath }: { subPath: string }) {
  const status = useStatus();
  if (!status.data) {
    return (
      <div className="flex h-full flex-col">
        <div className="h-12 border-b border-border/60" />
        <SkeletonRows count={8} className="px-1.5 pt-8" />
      </div>
    );
  }
  if (!status.data.configured) return <SetupState status={status.data} />;
  if (status.data.error && BLOCKING_KINDS.has(status.data.error.kind)) return <ConnectionError status={status.data} />;
  return <ConnectedPage subPath={subPath} />;
}

function ConnectedPage({ subPath }: { subPath: string }) {
  const navigate = useBbNavigate();
  const route = useMemo(() => parseSubPath(subPath), [subPath]);
  const [lastSource, saveLastSource] = useLastSource();
  const source: ListSource = route.source ?? lastSource ?? DEFAULT_SOURCE;
  const sourceKey = source.kind === "view" ? `view:${source.viewId}` : `search:${source.jql}`;
  const openKey = route.issueKey;

  useEffect(() => {
    if (route.source) saveLastSource(route.source);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey]);

  const { ref: pageRef, width, element: pageElement } = useContainerWidth<HTMLDivElement>();
  const split = width >= SPLIT_MIN_WIDTH;
  const now = useNow();

  const [limit, setLimit] = useState(LIST_LIMIT_DEFAULT);
  useEffect(() => setLimit(LIST_LIMIT_DEFAULT), [sourceKey]);

  const list = useIssueList(source, limit);
  const views = useViews();
  const refresh = useRefresh();
  const { create: createView } = useViewMutations();

  const result = list.data;
  const issues = useMemo(() => result?.issues ?? [], [result]);
  const order = useMemo(() => visualOrder(groupIssues(issues)), [issues]);

  // Selection follows the keyboard; it starts on the open issue.
  const [selectedKey, setSelectedKey] = useState<string | null>(openKey);
  const previousOrder = useRef<string[]>(order);
  useEffect(() => {
    // The open issue keeps the selection even when it is past the loaded rows.
    setSelectedKey((current) =>
      current !== null && current === openKey ? current : reconcileSelection(previousOrder.current, order, current),
    );
    previousOrder.current = order;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order]);
  useEffect(() => {
    if (openKey) setSelectedKey(openKey);
  }, [openKey]);

  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const searchRef = useRef<HTMLInputElement>(null);

  const go = useCallback(
    (nextSource: ListSource | null, issueKey: string | null, replace = false) => {
      navigate.toPluginPanel(PANEL_PATH, { subPath: formatSubPath(nextSource, issueKey), replace });
    },
    [navigate],
  );

  const open = useCallback(
    (key: string, replace = false) => {
      setSelectedKey(key);
      go(route.source ?? source, key, replace);
    },
    [go, route.source, source],
  );
  const close = useCallback(() => {
    go(route.source ?? source, null);
    const key = openKey;
    // Return focus to the row the document came from.
    window.requestAnimationFrame(() => {
      if (key) rowRefs.current.get(key)?.focus({ preventScroll: false });
    });
  }, [go, openKey, route.source, source]);

  const move = useCallback(
    (delta: number) => {
      const next = moveSelection(order, selectedKey, delta);
      if (!next) return;
      setSelectedKey(next);
      const element = rowRefs.current.get(next);
      element?.focus({ preventScroll: true });
      element?.scrollIntoView({ block: "nearest" });
      // In the split the document follows the selection, like a reading pane.
      if (split && openKey !== null) open(next, true);
    },
    [open, openKey, order, selectedKey, split],
  );

  const doRefresh = useCallback(async () => {
    const input = source.kind === "view" ? { viewId: source.viewId, limit } : { jql: source.jql, limit };
    const outcomes = await Promise.all([
      refresh.mutate(input),
      ...(openKey ? [refresh.mutate({ key: openKey })] : []),
    ]).catch((error: unknown) => {
      toast.error(`Not refreshed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    });
    // Jira failures show inline (the list banner, the document's note); only a
    // refused call, handled above, needs a toast.
    void outcomes;
  }, [limit, openKey, refresh, source]);

  // bb answers Escape with "Back to app" while this page owns the sidebar.
  // With an issue open, Escape closes the issue instead: claim it in the
  // capture phase, unless the user is typing or a dialog or popover is open.
  useEffect(() => {
    if (!openKey) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || isTypingTarget(event.target)) return;
      if (document.querySelector('[role="dialog"], [data-radix-popper-content-wrapper]')) return;
      const root = pageElement.current;
      if (!root?.isConnected) return;
      const active = document.activeElement;
      if (active && active !== document.body && !root.contains(active)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [openKey, close, pageElement]);

  const documentShown = openKey !== null;
  useHotkeys(
    [
      { key: ["j", "ArrowDown"], handler: () => move(1), description: "Next issue", group: "Navigation" },
      { key: ["k", "ArrowUp"], handler: () => move(-1), description: "Previous issue", group: "Navigation" },
      {
        key: "Enter",
        handler: () => {
          if (selectedKey) open(selectedKey);
        },
        description: "Open issue",
        group: "Navigation",
        enabled: selectedKey !== null && (split || !documentShown),
      },
      {
        key: "/",
        handler: () => searchRef.current?.focus(),
        description: "Search or JQL",
        group: "Navigation",
      },
      { key: "r", handler: () => void doRefresh(), description: "Refresh", group: "List" },
    ],
    { scope: pageElement },
  );

  const viewName =
    source.kind === "view"
      ? (views.data?.views.find((view) => view.id === source.viewId)?.name ?? (views.data ? null : ""))
      : "Search";
  const refreshing = Boolean(result?.refreshing) || refresh.isPending || (list.isFetching && !list.isLoading);
  const listError = result?.error ?? null;

  const listColumn = (
    <div className={cn("flex min-h-0 min-w-0 flex-col", split ? "w-[min(42%,30rem)] shrink-0 border-r border-border/60" : "flex-1")}>
      <Toolbar
        searchRef={searchRef}
        source={source}
        refreshing={refreshing}
        onRefresh={() => void doRefresh()}
        onSearch={(intent) => {
          if (intent.kind === "key") go(route.source ?? source, intent.key);
          else if (intent.kind === "jql" || intent.kind === "text") go({ kind: "search", jql: intent.jql }, null);
          else go(lastViewOr(lastSource), null);
        }}
      />
      <SourceCaption
        title={viewName}
        source={source}
        count={result?.fetchedAt != null ? issues.length : null}
        hasMore={result?.hasMore ?? false}
        onSave={async (name) => {
          if (source.kind !== "search") return;
          try {
            const view = await createView.mutate({ name, jql: source.jql });
            go({ kind: "view", viewId: view.id }, openKey);
            toast.success(`Saved view ${view.name}`);
          } catch (error) {
            toast.error(`Not saved: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
          }
        }}
      />
      {listError && issues.length > 0 ? <ListBanner failure={listError} onRetry={() => void doRefresh()} /> : null}
      <div className="@container min-h-0 flex-1 overflow-y-auto" data-issue-scroll>
        {list.isLoading || (result && result.fetchedAt === null && result.refreshing) ? (
          <SkeletonRows count={10} className="px-1.5 pt-8" />
        ) : list.error && !result ? (
          <EmptyState
            tone="error"
            icon="AlertCircle"
            title={list.error.code === "not_found" ? "This view no longer exists" : "Could not load issues"}
            description={list.error.message}
            action={
              <Button size="sm" variant="outline" onClick={() => go(DEFAULT_SOURCE, null)}>
                Show my open issues
              </Button>
            }
          />
        ) : listError && issues.length === 0 ? (
          <ListFailure failure={listError} onRetry={() => void doRefresh()} />
        ) : issues.length === 0 ? (
          <EmptyState
            icon="Search"
            title={source.kind === "search" ? "No issues match" : "Nothing here right now"}
            description={
              source.kind === "search"
                ? "Jira found no issues for this search. Try fewer words or another JQL query."
                : "Jira returned no issues for this view."
            }
          />
        ) : (
          <IssueList
            issues={issues}
            hasMore={result?.hasMore ?? false}
            limit={limit}
            now={now}
            selectedKey={selectedKey}
            openKey={openKey}
            onSelect={setSelectedKey}
            onOpen={(key) => open(key)}
            onLoadMore={() => setLimit((current) => Math.min(LIST_LIMIT_MAX, current + PAGE_STEP))}
            rowRefs={rowRefs}
          />
        )}
      </div>
    </div>
  );

  return (
    <div ref={pageRef} className="flex h-full min-h-0 w-full">
      {split || !documentShown ? listColumn : null}
      {split && !documentShown && issues.length === 0 ? <div className="flex-1" /> : null}
      {documentShown ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <IssueDocument
            key={openKey}
            issueKey={openKey}
            onOpenIssue={(key) => open(key)}
            onClose={close}
            closeLabel={split ? "Close issue" : "Back to list"}
            showBackBar={!split}
          />
        </div>
      ) : split && issues.length > 0 ? (
        <div className="flex min-w-0 flex-1 items-center justify-center">
          <p className="text-sm text-muted-foreground">
            Select an issue. <Kbd>J</Kbd> <Kbd>K</Kbd> to move, <Kbd>Enter</Kbd> to open.
          </p>
        </div>
      ) : null}
    </div>
  );
}

function lastViewOr(source: ListSource | null): ListSource {
  return source?.kind === "view" ? source : DEFAULT_SOURCE;
}

function Toolbar({
  searchRef,
  source,
  refreshing,
  onRefresh,
  onSearch,
}: {
  searchRef: React.RefObject<HTMLInputElement | null>;
  source: ListSource;
  refreshing: boolean;
  onRefresh: () => void;
  onSearch: (intent: ReturnType<typeof classifySearch>) => void;
}) {
  const [value, setValue] = useState(source.kind === "search" ? source.jql : "");
  useEffect(() => setValue(source.kind === "search" ? source.jql : ""), [source]);
  const intent = classifySearch(value);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSearch(intent);
  };
  return (
    <div className="relative flex h-12 shrink-0 items-center gap-2 border-b border-border/60 px-3">
      <form role="search" onSubmit={submit} className="flex min-w-0 flex-1 items-center gap-2">
        <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md bg-muted/60 px-2.5 focus-within:ring-1 focus-within:ring-ring">
          <Icon name="Search" className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            ref={searchRef}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                if (value !== "" && source.kind !== "search") setValue("");
                else event.currentTarget.blur();
              }
            }}
            placeholder="Search or JQL"
            aria-label="Search issues or enter JQL"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
          {value === "" ? (
            <Kbd>/</Kbd>
          ) : (
            <span className="shrink-0 text-xs text-muted-foreground">
              {intent.kind === "jql" ? "JQL" : intent.kind === "key" ? "Open issue" : "Text"}
            </span>
          )}
        </label>
      </form>
      <Button size="sm" variant="ghost" onClick={onRefresh} aria-keyshortcuts="r" className="gap-1.5 px-2">
        Refresh <Kbd>R</Kbd>
      </Button>
      <ShortcutSheet
        extra={[
          { keys: ["n"], description: "New view", group: "Views" },
          { keys: ["alt+ArrowUp", "alt+ArrowDown"], description: "Move the focused view", group: "Views" },
        ]}
      />
      <ProgressLine active={refreshing} />
    </div>
  );
}

function SourceCaption({
  title,
  source,
  count,
  hasMore,
  onSave,
}: {
  title: string | null;
  source: ListSource;
  /** Null until the list has loaded once. */
  count: number | null;
  hasMore: boolean;
  onSave: (name: string) => Promise<void>;
}) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  useEffect(() => {
    setNaming(false);
    setName("");
  }, [source]);
  return (
    <div className="flex min-h-10 shrink-0 items-center gap-2 px-4 pt-2">
      {naming ? (
        <form
          className="flex min-w-0 flex-1 items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = name.trim();
            if (trimmed === "") return;
            setNaming(false);
            void onSave(trimmed).catch(() => setNaming(true));
          }}
        >
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setNaming(false);
              }
            }}
            placeholder="View name"
            aria-label="View name"
            maxLength={80}
            className="h-7 min-w-0 flex-1 rounded-md border border-border bg-transparent px-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          <Button type="submit" size="sm" variant="outline" className="h-7">
            Save view
          </Button>
        </form>
      ) : (
        <>
          <h2 className="min-w-0 truncate text-sm font-medium text-foreground" title={source.kind === "search" ? source.jql : undefined}>
            {title ?? "View"}
          </h2>
          {count !== null ? (
            <span className="text-xs tabular-nums text-muted-foreground">
              {count}
              {hasMore ? "+" : ""}
            </span>
          ) : null}
          <span className="flex-1" />
          {source.kind === "search" ? (
            <Button size="sm" variant="ghost" className="h-7 px-2 text-muted-foreground" onClick={() => setNaming(true)}>
              Save as view
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}

function ListBanner({ failure, onRetry }: { failure: Failure; onRetry: () => void }) {
  const copy = failureCopy(failure);
  return (
    <div role="status" className="mx-3 mb-1 flex items-center gap-2 rounded-lg bg-attention/10 px-3 py-1.5 text-xs text-foreground">
      <Icon name="AlertTriangle" className="size-3.5 shrink-0 text-warning-text" />
      <span className="min-w-0 flex-1">
        {failure.kind === "rate_limited" ? copy.description : `Showing cached issues. ${copy.title}.`}
      </span>
      {copy.action === "retry" || copy.action === "check" ? (
        <button type="button" onClick={onRetry} className="shrink-0 rounded px-1 font-medium underline-offset-4 hover:underline focus-visible:ring-1 focus-visible:ring-ring">
          {copy.actionLabel}
        </button>
      ) : null}
    </div>
  );
}

function ListFailure({ failure, onRetry }: { failure: Failure; onRetry: () => void }) {
  const copy = failureCopy(failure);
  return (
    <EmptyState
      tone="error"
      icon="AlertCircle"
      title={copy.title}
      description={copy.description}
      action={
        copy.action === "retry" || copy.action === "check" ? (
          <Button size="sm" variant="outline" onClick={onRetry}>
            {copy.actionLabel}
          </Button>
        ) : undefined
      }
    />
  );
}

export { DocumentSkeleton };
