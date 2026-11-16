// The Task Board page (navPanel "board").
import { useCallback, useEffect, useMemo, useRef } from "react";
import { experimental_useAppPanel, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { EmptyState, Kbd, ProgressLine, Skeleton, useHotkeys } from "../kit";
import { Button } from "../components/ui/button";
import { Icon } from "../components/ui/icon";
import type { TaskCard } from "../src/schemas";
import { Board } from "./Board";
import { useBoard, useBoardWrites, useTask } from "./data";
import { useShownTask } from "./detail-bus";
import { useProjects } from "./Header";
import { ListView } from "./ListView";
import { columnsOf, isFiltering, matches, NO_FILTERS, parseRoute, routePath, type BoardData } from "./model";
import { focusSearch, getView, lastScope, rememberScope, setFilters, setView, useView } from "./store";
import { openTaskTab } from "./tabs";
import { ThreadStatusProvider } from "./threads";
import { TaskView } from "./Detail";
import { AnimatePresence, motion } from "motion/react";
import { useKitMotion } from "../kit";
import { useState } from "react";

function BoardSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 gap-4 overflow-hidden px-4 pt-3 md:px-5" aria-busy="true" aria-label="Loading the board">
      {[3, 2, 1, 2].map((cards, column) => (
        <div key={column} className="flex w-[min(18rem,calc(100vw-2.5rem))] shrink-0 flex-col gap-2 px-1">
          <div className="flex h-9 items-center">
            <Skeleton className="h-4 w-24" />
          </div>
          {Array.from({ length: cards }, (_, index) => (
            <Skeleton key={index} className="h-[4.5rem] w-full rounded-lg" />
          ))}
        </div>
      ))}
    </div>
  );
}

export function BoardPage({ subPath }: { subPath: string }) {
  const route = useMemo(() => parseRoute(subPath), [subPath]);
  const navigate = useBbNavigate();
  const panel = experimental_useAppPanel();
  const projects = useProjects();
  const { scope, view, filters } = useView();
  const routedTask = useTask(route.kind === "task" ? route.taskId : null);
  const shownTaskId = useShownTask();

  // Resolve the scope from the route, the last board used, or the first project.
  useEffect(() => {
    let next: string | null = null;
    if (route.kind === "project") next = route.projectId;
    else if (route.kind === "all") next = "all";
    else if (route.kind === "task") next = routedTask.data?.task?.projectId ?? (routedTask.data ? lastScope() ?? "all" : null);
    else if (projects) {
      const last = lastScope();
      next = last === "all" || (last && projects.some((project) => project.id === last)) ? last : projects[0]?.id ?? "all";
    }
    if (next && next !== scope) setView({ scope: next, filters: NO_FILTERS });
    if (next) rememberScope(next);
  }, [route, routedTask.data, projects, scope]);

  // Where the side panel cannot open (bb's compact layout), the task opens as
  // a sheet over the board instead.
  const [sheetTaskId, setSheetTaskId] = useState<string | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const showTask = useCallback(
    (taskId: string, title = "Task") => {
      const accepted = openTaskTab(panel, taskId, title);
      const focused = document.activeElement as HTMLElement | null;
      // bb's compact layout accepts the tab but keeps its drawer closed; a
      // cold page opens the panel a few frames later. Decide after both.
      const fallBack = () => {
        returnFocus.current = focused;
        setSheetTaskId(taskId);
      };
      window.setTimeout(() => {
        if (accepted && panel.getTabs().open) return;
        // A cold page may not have its panel ready yet: ask once more.
        const again = openTaskTab(panel, taskId, title);
        window.setTimeout(() => {
          if (!(again && panel.getTabs().open)) fallBack();
        }, 220);
      }, 160);
    },
    [panel],
  );
  const closeSheet = useCallback(() => {
    setSheetTaskId(null);
    requestAnimationFrame(() => returnFocus.current?.focus());
  }, []);

  const openTask = useCallback(
    (task: { id: string; title: string }, replaceRoute = true) => {
      showTask(task.id, task.title);
      if (replaceRoute && scope) navigate.toPluginPanel("board", { subPath: routePath(scope, task.id), replace: true });
    },
    [navigate, scope, showTask],
  );

  // The cross-plugin route /board/task/<id> becomes the canonical
  // /board/p/<project>/task/<id> as soon as the task's project is known; bb's
  // side panel only takes tabs on the canonical board route.
  useEffect(() => {
    if (route.kind !== "task") return;
    const projectId = routedTask.data?.task?.projectId;
    if (projectId) navigate.toPluginPanel("board", { subPath: routePath(projectId, route.taskId), replace: true });
  }, [navigate, route, routedTask.data]);


  const board = useBoard(scope);
  const writes = useBoardWrites(scope);

  const filtering = isFiltering(filters);
  const data = board.data as BoardData | undefined;

  // A route naming a task opens it once.
  const opened = useRef<string | null>(null);
  const routeTaskId = route.taskId;
  useEffect(() => {
    if (!routeTaskId || opened.current === routeTaskId) return;
    if (route.kind === "task" || !data) return;
    opened.current = routeTaskId;
    // Give bb's page panel a moment to mount; in the compact layout showTask
    // falls back to the sheet.
    const title = data?.tasks.find((task) => task.id === routeTaskId)?.title ?? "Task";
    const timer = window.setTimeout(() => showTask(routeTaskId, title), 300);
    return () => window.clearTimeout(timer);
  }, [route.kind, routeTaskId, data, showTask]);
  const filtered = useMemo<BoardData | undefined>(
    () => (data && filtering ? { ...data, tasks: data.tasks.filter((task) => matches(task, filters)) } : data),
    [data, filtering, filters],
  );
  const columns = useMemo(() => (filtered ? columnsOf(filtered, scope === "all" ? "all" : "project") : []), [filtered, scope]);
  const threadIds = useMemo(() => (data ? data.tasks.flatMap((task) => task.threadIds) : []), [data]);
  const projectNames = useMemo(
    () => (scope === "all" && data ? new Map(data.projects.map((project) => [project.id, project.name])) : null),
    [data, scope],
  );

  useHotkeys([
    { key: "/", handler: () => void focusSearch(), description: "Search", group: "Board" },
  ]);

  const onOpen = useCallback((task: TaskCard) => openTask(task), [openTask]);

  let body: React.ReactNode;
  if (route.kind === "task" && routedTask.data && routedTask.data.task === null) {
    body = (
      <div className="p-6">
        <EmptyState
          icon="ListTodo"
          title="That task no longer exists"
          description="It was deleted. The board is one click away."
          action={
            <Button size="sm" variant="outline" onClick={() => navigate.toPluginPanel("board", { subPath: "", replace: true })}>
              Open the board
            </Button>
          }
        />
      </div>
    );
  } else if (board.error && !data) {
    body = (
      <div className="p-6">
        <EmptyState
          tone="error"
          icon="AlertCircle"
          title="Could not load the board"
          description={`${board.error.message}. Check that the Task Board plugin is running in Settings, then try again.`}
          action={
            <Button size="sm" variant="outline" onClick={() => void board.refetch()}>
              Try again
            </Button>
          }
        />
      </div>
    );
  } else if (!data) {
    body = <BoardSkeleton />;
  } else if (scope === "all" && data.tasks.length === 0) {
    body = (
      <div className="p-6">
        <EmptyState
          icon="ListTodo"
          title="No tasks on any board yet"
          description="Each project has its own board. Pick one to add the first task."
          action={
            projects?.[0] ? (
              <Button size="sm" variant="outline" onClick={() => navigate.toPluginPanel("board", { subPath: routePath(projects[0]!.id, null) })}>
                Open {projects[0]!.name}
              </Button>
            ) : undefined
          }
        />
      </div>
    );
  } else {
    body = (
      <ThreadStatusProvider threadIds={threadIds}>
        {filtering ? (
          <div className="flex h-8 shrink-0 items-center gap-3 px-5 text-xs text-muted-foreground">
            <span className="tabular-nums">
              Showing {filtered?.tasks.length ?? 0} of {data.tasks.length}
            </span>
            <button
              type="button"
              onClick={() => setFilters(NO_FILTERS)}
              className="rounded-md text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Clear search and filters
            </button>
          </div>
        ) : data.tasks.length === 0 && scope !== "all" ? (
          <p className="shrink-0 px-5 pt-3 text-sm text-muted-foreground">
            Plan the work for this project. Press <Kbd>N</Kbd> to add a task, then <Kbd>S</Kbd> on a card to start work in a
            thread.
          </p>
        ) : null}
        {view === "board" ? (
          <Board
            board={filtered!}
            columns={columns}
            scope={scope!}
            writes={writes}
            selectedId={shownTaskId}
            onOpen={onOpen}
            projectNames={projectNames}
            filtering={filtering}
          />
        ) : (
          <ListView columns={columns} selectedId={shownTaskId} onOpen={onOpen} projectNames={projectNames} />
        )}
      </ThreadStatusProvider>
    );
  }

  // The host shrink-wraps header content and the side panel can take half the
  // page, so the header sizes itself from this width (see BoardHeader).
  const pageRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = pageRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const width = Math.round(entry!.contentRect.width);
      if (Math.abs(width - getView().pageWidth) >= 8) setView({ pageWidth: width });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={pageRef} className="relative flex h-full min-h-0 flex-col">
      <ProgressLine active={board.isFetching && !board.isLoading && data !== undefined} />
      {body}
      <TaskSheet taskId={sheetTaskId} onClose={closeSheet} />
    </div>
  );
}

function TaskSheet({ taskId, onClose }: { taskId: string | null; onClose: () => void }) {
  const { variants } = useKitMotion();
  const sheet = useRef<HTMLDivElement>(null);
  useHotkeys([{ key: "Escape", handler: onClose, enabled: taskId !== null, allowInInputs: false }]);
  return (
    <AnimatePresence>
      {taskId ? (
        <motion.div
          ref={sheet}
          key="sheet"
          role="dialog"
          aria-modal="true"
          aria-label="Task"
          tabIndex={-1}
          variants={variants.fadeScale}
          initial="hidden"
          animate="visible"
          exit="exit"
          className="absolute inset-0 z-20 flex flex-col bg-background outline-none"
        >
          <div className="flex h-10 shrink-0 items-center border-b border-border/60 px-2">
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-sm text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Icon name="ChevronRight" className="size-3.5 rotate-180" aria-hidden />
              Board
            </button>
            <span className="ml-auto pr-2 text-xs text-muted-foreground">
              <Kbd>Esc</Kbd>
            </span>
          </div>
          <div className="min-h-0 flex-1">
            <TaskView taskId={taskId} active autoFocus />
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
