// The board: open lanes of flat cards.
//
// Drag picks a card up with the `lift` spring and neighbours make room with
// `shift`. Keyboard: Space picks up, arrows move, Space drops, Escape
// cancels. A move is written optimistically; a refused one animates back.
// Cards carry a layoutId, so when an agent moves a card the card travels to
// its new lane by itself.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, LayoutGroup, animate, motion, useMotionValue, type MotionValue, type TargetAndTransition } from "motion/react";
import { toast } from "sonner";
import { InlineComposer, Kbd, shortcutLabel, spring, useHotkeys, useKitMotion } from "../kit";
import { Icon } from "../components/ui/icon";
import { usePortalScopeProps } from "../lib/portal-scope";
import { cn } from "../lib/utils";
import type { TaskCard } from "../src/schemas";
import { Card } from "./Card";
import { newTaskId, type BoardWrites } from "./data";
import { LaneMenu } from "./LaneMenu";
import {
  dropAnchors,
  dropIndex,
  laneForDrop,
  moveCursor,
  moveLifted,
  previewLift,
  type BoardData,
  type Column,
  type Cursor,
} from "./model";
import { requestStartWork } from "./detail-bus";
import { onNewTaskRequest, takePendingNewTask } from "./commands";

interface DragState {
  taskId: string;
  target: Cursor;
  origin: Cursor;
  /** Pointer drag: the clone's geometry. Keyboard lift has none. */
  pointer: {
    startX: number;
    startY: number;
    dx: number;
    dy: number;
    rect: DOMRect;
    scrollLeft: number;
    scrollTop: number;
    columns: Array<{ left: number; right: number }>;
    mids: number[][];
  } | null;
}

const GAP = 8;

export function Board({
  board,
  columns,
  scope,
  writes,
  selectedId,
  onOpen,
  projectNames,
  filtering,
}: {
  board: BoardData;
  columns: Column[];
  scope: string;
  writes: BoardWrites;
  selectedId: string | null;
  onOpen: (task: TaskCard) => void;
  projectNames: Map<string, string> | null;
  filtering: boolean;
}) {
  const { reduced, transition, variants } = useKitMotion();
  const cloneX = useMotionValue(0);
  const cloneY = useMotionValue(0);
  const portal = usePortalScopeProps();
  const container = useRef<HTMLDivElement>(null);
  const cardEls = useRef(new Map<string, HTMLDivElement>());
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [settling, setSettling] = useState<string | null>(null);
  const [composer, setComposer] = useState<{ columnId: string; at: "top" | "bottom" } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;

  const tasksById = useMemo(() => new Map(board.tasks.map((task) => [task.id, task])), [board.tasks]);
  // Ids already on screen before this render: such a card that appears in a
  // new lane is travelling there (layoutId), not entering, so it skips the
  // fade-in and stays on top of the lanes it crosses.
  const seenIds = useRef(new Set<string>());
  const known = seenIds.current;
  useEffect(() => {
    seenIds.current = new Set(board.tasks.map((task) => task.id));
  }, [board.tasks]);
  const taskIds = useMemo(() => new Set(board.tasks.map((task) => task.id)), [board.tasks]);
  const dragged = drag ? tasksById.get(drag.taskId) ?? null : null;

  // What is on screen: the columns, or the columns as they would be after the drop.
  const shown: TaskCard[][] = useMemo(
    () => (drag && dragged ? previewLift(columns, dragged, drag.target) : columns.map((column) => column.tasks)),
    [columns, drag, dragged],
  );

  const cursorOf = useCallback(
    (taskId: string | null): Cursor | null => {
      if (!taskId) return null;
      for (let column = 0; column < shown.length; column += 1) {
        const row = shown[column]!.findIndex((task) => task.id === taskId);
        if (row >= 0) return { column, row };
      }
      return null;
    },
    [shown],
  );

  // Focus follows its card, wherever an agent or another window moves it.
  const focusCard = useCallback((taskId: string | null, scroll = true) => {
    setFocusedId(taskId);
    if (!taskId) return;
    requestAnimationFrame(() => {
      const el = cardEls.current.get(taskId);
      if (el && document.activeElement !== el) el.focus({ preventScroll: !scroll });
      if (scroll) el?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  }, []);

  useEffect(() => {
    if (focusedId && !taskIds.has(focusedId)) setFocusedId(null);
  }, [focusedId, taskIds]);

  const firstTask = shown.find((tasks) => tasks.length > 0)?.[0]?.id ?? null;
  const tabStop = focusedId && taskIds.has(focusedId) ? focusedId : firstTask;

  // -------------------------------------------------------------------------
  // Dropping

  const commitDrop = useCallback(
    (state: DragState) => {
      const task = tasksById.get(state.taskId);
      if (!task) return false;
      const column = columns[state.target.column]!;
      const unchanged =
        state.target.column === state.origin.column &&
        state.target.row === columns[state.origin.column]!.tasks.findIndex((row) => row.id === task.id);
      if (unchanged) return false;
      const laneId = laneForDrop(board, column, task);
      if (!laneId) {
        toast.error(`That project has no ${column.name} lane`);
        return false;
      }
      const anchors = dropAnchors(shown[state.target.column]!, state.target.row, task.id);
      void writes.move({ taskId: task.id, laneId, ...anchors }, task.title);
      setAnnouncement(`Moved ${task.title} to ${column.name}, position ${state.target.row + 1}.`);
      return true;
    },
    [board, columns, shown, tasksById, writes],
  );

  /** Fly the pointer clone to `el` (its slot), then end the drag. */
  const settleClone = useCallback(
    (state: DragState, back: boolean) => {
      const pointer = state.pointer;
      if (!pointer) {
        setDrag(null);
        return;
      }
      setSettling(state.taskId);
      setDrag(null);
      requestAnimationFrame(() => {
        const slot = cardEls.current.get(state.taskId);
        const to = !back && slot ? slot.getBoundingClientRect() : pointer.rect;
        const done = () => setSettling(null);
        if (reduced) {
          done();
          return;
        }
        const lift = spring.lift;
        Promise.all([
          animate(cloneX, to.left - pointer.rect.left, lift),
          animate(cloneY, to.top - pointer.rect.top, lift),
        ]).then(done, done);
      });
    },
    [cloneX, cloneY, reduced],
  );

  // -------------------------------------------------------------------------
  // Pointer drag

  const pending = useRef<{ taskId: string; x: number; y: number; pointerId: number } | null>(null);
  const autoScroll = useRef<{ dx: number; dy: number; frame: number | null }>({ dx: 0, dy: 0, frame: null });

  const startPointerDrag = useCallback(
    (taskId: string, x: number, y: number) => {
      const el = cardEls.current.get(taskId);
      const box = container.current;
      const origin = cursorOf(taskId);
      if (!el || !box || !origin) return;
      const rect = el.getBoundingClientRect();
      const columnEls = Array.from(box.querySelectorAll<HTMLElement>("[data-column-index]"));
      const columnsGeo = columnEls.map((column) => {
        const r = column.getBoundingClientRect();
        return { left: r.left, right: r.right };
      });
      const mids = columns.map((column, index) =>
        column.tasks
          .filter((task) => task.id !== taskId)
          .map((task) => {
            const r = cardEls.current.get(task.id)?.getBoundingClientRect();
            if (!r) return Number.POSITIVE_INFINITY;
            const below = index === origin.column && r.top > rect.top;
            return r.top + r.height / 2 - (below ? rect.height + GAP : 0);
          }),
      );
      setFocusedId(taskId);
      cloneX.set(0);
      cloneY.set(0);
      // No text selection while dragging across the page.
      window.getSelection()?.removeAllRanges();
      document.body.style.userSelect = "none";
      setDrag({
        taskId,
        origin,
        target: origin,
        pointer: {
          startX: x,
          startY: y,
          dx: 0,
          dy: 0,
          rect,
          scrollLeft: box.scrollLeft,
          scrollTop: box.scrollTop,
          columns: columnsGeo,
          mids,
        },
      });
      const task = tasksById.get(taskId);
      if (task) setAnnouncement(`Picked up ${task.title}.`);
    },
    [cloneX, cloneY, columns, cursorOf, tasksById],
  );

  const updatePointer = useCallback((x: number, y: number) => {
    setDrag((state) => {
      if (!state?.pointer) return state;
      const box = container.current;
      const p = state.pointer;
      const sx = (box?.scrollLeft ?? p.scrollLeft) - p.scrollLeft;
      const sy = (box?.scrollTop ?? p.scrollTop) - p.scrollTop;
      const px = x + sx;
      const py = y + sy;
      let column = p.columns.findIndex((geo) => px >= geo.left && px <= geo.right);
      if (column < 0) {
        let best = Number.POSITIVE_INFINITY;
        p.columns.forEach((geo, index) => {
          const distance = Math.min(Math.abs(px - geo.left), Math.abs(px - geo.right));
          if (distance < best) {
            best = distance;
            column = index;
          }
        });
      }
      const row = dropIndex(py, p.mids[column] ?? []);
      const target = { column, row };
      cloneX.set(x - p.startX);
      cloneY.set(y - p.startY);
      return {
        ...state,
        target,
        pointer: { ...p, dx: x - p.startX, dy: y - p.startY },
      };
    });
    // Scroll the board when the pointer nears its edges.
    const box = container.current;
    if (!box) return;
    const r = box.getBoundingClientRect();
    const edge = 48;
    const speed = (distance: number) => Math.round(((edge - distance) / edge) * 14);
    autoScroll.current.dx = x < r.left + edge ? -speed(x - r.left) : x > r.right - edge ? speed(r.right - x) : 0;
    autoScroll.current.dy = y < r.top + edge ? -speed(y - r.top) : y > r.bottom - edge ? speed(r.bottom - y) : 0;
    if ((autoScroll.current.dx || autoScroll.current.dy) && autoScroll.current.frame === null) {
      const tick = () => {
        const { dx, dy } = autoScroll.current;
        if (!dragRef.current || (!dx && !dy)) {
          autoScroll.current.frame = null;
          return;
        }
        box.scrollBy(dx, dy);
        autoScroll.current.frame = requestAnimationFrame(tick);
      };
      autoScroll.current.frame = requestAnimationFrame(tick);
    }
  }, [cloneX, cloneY]);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const start = pending.current;
      if (start && !dragRef.current) {
        if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < 5) return;
        startPointerDrag(start.taskId, start.x, start.y);
      }
      if (dragRef.current?.pointer) updatePointer(event.clientX, event.clientY);
    };
    const onUp = () => {
      document.body.style.userSelect = "";
      const start = pending.current;
      pending.current = null;
      autoScroll.current.dx = 0;
      autoScroll.current.dy = 0;
      const state = dragRef.current;
      if (state?.pointer) {
        const moved = commitDrop(state);
        settleClone(state, !moved);
        return;
      }
      if (start) {
        const task = tasksById.get(start.taskId);
        if (task) {
          focusCard(task.id, false);
          onOpen(task);
        }
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [commitDrop, focusCard, onOpen, settleClone, startPointerDrag, tasksById, updatePointer]);

  const onCardPointerDown = (event: ReactPointerEvent<HTMLDivElement>, taskId: string) => {
    if (event.button !== 0 || event.pointerType === "touch") return;
    if ((event.target as HTMLElement).closest("a,button,input,textarea")) return;
    pending.current = { taskId, x: event.clientX, y: event.clientY, pointerId: event.pointerId };
  };

  // -------------------------------------------------------------------------
  // Keyboard

  const lifted = drag && !drag.pointer ? drag : null;

  const move = (key: "up" | "down" | "left" | "right" | "first" | "last") => {
    if (lifted) {
      if (key === "first" || key === "last") return;
      const target = moveLifted(columns, lifted.taskId, lifted.target, key);
      setDrag({ ...lifted, target });
      const column = columns[target.column]!;
      setAnnouncement(`${column.name}, position ${target.row + 1}.`);
      focusCard(lifted.taskId);
      return;
    }
    const cursor = cursorOf(focusedId) ?? cursorOf(firstTask);
    if (!cursor) return;
    const next = moveCursor(
      shown.map((tasks) => ({ tasks })),
      cursor,
      key,
    );
    focusCard(shown[next.column]?.[next.row]?.id ?? null);
  };

  const pickUpOrDrop = () => {
    if (lifted) {
      commitDrop(lifted);
      setDrag(null);
      focusCard(lifted.taskId);
      return;
    }
    const cursor = cursorOf(focusedId);
    if (!cursor || !focusedId) return;
    if (filtering) {
      toast("Clear the search and filters to move cards with the keyboard");
      return;
    }
    const task = tasksById.get(focusedId);
    setDrag({ taskId: focusedId, origin: cursor, target: cursor, pointer: null });
    setAnnouncement(`Picked up ${task?.title ?? "task"}. Use the arrow keys to move it, Space to drop, Escape to cancel.`);
  };

  const cancel = () => {
    if (drag?.pointer) {
      settleClone(drag, true);
      pending.current = null;
      setAnnouncement("Move cancelled.");
      return true;
    }
    if (lifted) {
      setDrag(null);
      focusCard(lifted.taskId);
      setAnnouncement("Move cancelled.");
      return true;
    }
    if (composer) {
      setComposer(null);
      return true;
    }
    return false;
  };

  const focusedColumn = () => {
    const cursor = cursorOf(focusedId);
    return columns[cursor?.column ?? 0] ?? null;
  };

  const openComposer = (columnId: string, at: "top" | "bottom") => {
    if (scope === "all") {
      toast("Pick a project to add tasks");
      return;
    }
    setComposer({ columnId, at });
  };

  // "Task Board: New task" from the palette opens the first lane's composer.
  const firstColumnId = columns[0]?.id ?? null;
  useEffect(() => {
    const consume = () => {
      if (firstColumnId && scope !== "all" && takePendingNewTask()) setComposer({ columnId: firstColumnId, at: "top" });
    };
    consume();
    return onNewTaskRequest(consume);
  }, [firstColumnId, scope]);

  useHotkeys(
    [
      { key: ["j", "ArrowDown"], handler: () => move("down"), description: "Next card", group: "Board" },
      { key: ["k", "ArrowUp"], handler: () => move("up"), description: "Previous card", group: "Board" },
      { key: ["h", "ArrowLeft"], handler: () => move("left"), description: "Lane to the left", group: "Board" },
      { key: ["l", "ArrowRight"], handler: () => move("right"), description: "Lane to the right", group: "Board" },
      { key: "Home", handler: () => move("first") },
      { key: "End", handler: () => move("last") },
      {
        key: " ",
        handler: (event) => {
          event.preventDefault();
          pickUpOrDrop();
        },
        description: "Pick up or drop the card",
        group: "Board",
      },
      {
        key: "Enter",
        handler: () => {
          if (lifted) return pickUpOrDrop();
          const task = focusedId ? tasksById.get(focusedId) : null;
          if (task) onOpen(task);
        },
        description: "Open the card",
        group: "Board",
      },
      {
        key: "n",
        handler: (event) => {
          event.preventDefault();
          const column = focusedColumn();
          if (column) openComposer(column.id, "top");
        },
        description: "New task in this lane",
        group: "Board",
      },
      {
        key: "s",
        handler: () => {
          const task = focusedId ? tasksById.get(focusedId) : null;
          if (task) requestStartWork(task, onOpen);
        },
        description: "Start work on the card",
        group: "Board",
      },
      {
        key: "Escape",
        preventDefault: false,
        handler: (event) => {
          if (cancel()) event.preventDefault();
        },
      },
    ],
    { scope: container },
  );

  // A pointer drag also listens for Escape while the pointer is down.
  useEffect(() => {
    if (!drag?.pointer) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  // -------------------------------------------------------------------------
  // Render

  const cardTransition = transition("shift");
  // A card that left this lane but is still on the board is travelling to
  // another lane (its layoutId animates there); it must not fade out here.
  const exitFor = (id: string) =>
    (taskIds.has(id) ? { opacity: 0, transition: { duration: 0 } } : variants.listItem!.exit) as TargetAndTransition;

  return (
    <LayoutGroup id="task-board">
      <div
        ref={container}
        role="application"
        aria-roledescription="board"
        aria-label="Task board"
        className={cn(
          "@container flex min-h-0 flex-1 gap-4 overflow-auto px-4 pb-6 pt-3 md:px-5",
          "snap-x snap-mandatory @2xl:snap-none",
          drag?.pointer && "cursor-grabbing select-none",
        )}
      >
        {columns.map((column, columnIndex) => {
          const tasks = shown[columnIndex] ?? [];
          const isTarget = drag !== null && drag.target.column === columnIndex;
          const composing = composer?.columnId === column.id;
          const hidden = column.total - column.tasks.length;
          return (
            <section
              key={column.id}
              data-column-index={columnIndex}
              aria-label={`${column.name}, ${column.total} ${column.total === 1 ? "task" : "tasks"}`}
              className={cn(
                "group/lane flex w-[min(18rem,calc(100cqw-2.5rem))] shrink-0 snap-start flex-col rounded-xl",
                "transition-colors duration-[120ms] ease-out",
                isTarget && drag?.pointer && "bg-muted/45",
              )}
            >
              <header className="flex h-9 items-center gap-2 px-1">
                <h2 className="min-w-0 truncate text-sm font-medium text-foreground">{column.name}</h2>
                <span className="text-xs tabular-nums text-muted-foreground">{column.total}</span>
                <span className="flex-1" />
                {scope !== "all" ? (
                  <div className="flex items-center gap-0.5 opacity-0 transition-opacity duration-[120ms] group-hover/lane:opacity-100 group-focus-within/lane:opacity-100 pointer-coarse:opacity-100">
                    <button
                      type="button"
                      onClick={() => openComposer(column.id, "top")}
                      title={`New task in ${column.name} (${shortcutLabel("n")})`}
                      aria-label={`New task in ${column.name}`}
                      className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Icon name="Plus" className="size-4" aria-hidden />
                    </button>
                    <LaneMenu board={board} laneId={column.id} />
                  </div>
                ) : null}
              </header>
              <div className={cn("relative flex min-h-16 flex-col gap-2 px-1 pb-2", tasks.length === 0 && !composing && "justify-start")}>
                {composing && composer?.at === "top" ? (
                  <ComposerSlot
                    column={column}
                    at="top"
                    projectId={scope}
                    writes={writes}
                    onClose={() => setComposer(null)}
                    onCreated={(name) => setAnnouncement(`Created ${name} in ${column.name}.`)}
                  />
                ) : null}
                <AnimatePresence initial={false} mode="popLayout">
                  {tasks.map((task) => {
                    const isDragged = drag?.taskId === task.id;
                    const placeholder = (isDragged && drag?.pointer !== null) || settling === task.id;
                    return (
                      <motion.div
                        key={task.id}
                        layout={reduced ? false : "position"}
                        // The pointer-drag placeholder jumps between lanes; only
                        // real cards travel (agent moves, drops, view switches).
                        layoutId={reduced || (isDragged && drag?.pointer) ? undefined : `card-${task.id}`}
                        transition={cardTransition}
                        variants={variants.listItem}
                        initial={known.has(task.id) ? false : "hidden"}
                        animate="visible"
                        exit={exitFor(task.id)}
                        className="relative"
                        style={{ zIndex: known.has(task.id) ? 2 : undefined }}
                      >
                        <Card
                          ref={(el) => {
                            if (el) cardEls.current.set(task.id, el);
                            else cardEls.current.delete(task.id);
                          }}
                          task={task}
                          projectName={projectNames?.get(task.projectId)}
                          selected={selectedId === task.id}
                          lifted={isDragged && !drag?.pointer}
                          placeholder={placeholder}
                          tabIndex={task.id === tabStop ? 0 : -1}
                          aria-roledescription="task card"
                          aria-label={task.title}
                          aria-keyshortcuts="Enter Space"
                          onFocus={() => setFocusedId(task.id)}
                          onPointerDown={(event) => onCardPointerDown(event, task.id)}
                          className={cn(
                            "cursor-pointer",
                            isDragged && !drag?.pointer && "scale-[1.02] transition-transform",
                          )}
                        />
                      </motion.div>
                    );
                  })}
                </AnimatePresence>
                {tasks.length === 0 && !composing ? (
                  <p className="px-1 py-3 text-xs text-muted-foreground">
                    {filtering ? "No matching tasks" : drag ? "Drop here" : "No tasks"}
                  </p>
                ) : null}
                {hidden > 0 && !filtering ? (
                  <p className="px-1 pt-1 text-xs tabular-nums text-muted-foreground">
                    {hidden} more not shown. Use the list view or search to find them.
                  </p>
                ) : null}
                {composing && composer?.at === "bottom" ? (
                  <ComposerSlot
                    column={column}
                    at="bottom"
                    projectId={scope}
                    writes={writes}
                    onClose={() => setComposer(null)}
                    onCreated={(name) => setAnnouncement(`Created ${name} in ${column.name}.`)}
                  />
                ) : scope !== "all" && !drag ? (
                  <button
                    type="button"
                    onClick={() => openComposer(column.id, "bottom")}
                    className={cn(
                      "flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs text-muted-foreground",
                      "hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      columnIndex === 0 || tasks.length === 0
                        ? "opacity-100"
                        : "opacity-0 group-hover/lane:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100",
                    )}
                  >
                    <Icon name="Plus" className="size-3.5" aria-hidden />
                    New task
                    {columnIndex === 0 ? <Kbd className="ml-auto">N</Kbd> : null}
                  </button>
                ) : null}
              </div>
            </section>
          );
        })}
        {scope !== "all" ? <AddLane board={board} projectId={scope} /> : null}
      </div>
      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>
      {(drag?.pointer || settling) && (dragged || settling)
        ? createPortal(
            <PointerClone
              x={cloneX}
              y={cloneY}
              portal={portal}
              drag={drag}
              task={dragged ?? tasksById.get(settling!) ?? null}
              projectName={projectNames?.get((dragged ?? tasksById.get(settling!))?.projectId ?? "")}
            />,
            document.body,
          )
        : null}
    </LayoutGroup>
  );
}

function PointerClone({
  x,
  y,
  portal,
  drag,
  task,
  projectName,
}: {
  x: MotionValue<number>;
  y: MotionValue<number>;
  portal: Record<string, string>;
  drag: DragState | null;
  task: TaskCard | null;
  projectName?: string;
}) {
  const rect = useRef<DOMRect | null>(null);
  if (drag?.pointer) rect.current = drag.pointer.rect;
  const { reduced, transition } = useKitMotion();
  if (!task || !rect.current) return null;
  const r = rect.current;
  const lifting = drag?.pointer !== undefined && drag?.pointer !== null;
  return (
    <div {...portal} className="pointer-events-none fixed z-50" style={{ left: r.left, top: r.top, width: r.width }}>
      <motion.div
        style={{ x, y }}
        initial={{ scale: 1 }}
        animate={{ scale: lifting && !reduced ? 1.02 : 1 }}
        transition={transition("lift")}
        className="will-change-transform"
      >
        <Card task={task} projectName={projectName} lifted className="cursor-grabbing" />
      </motion.div>
    </div>
  );
}

function ComposerSlot({
  column,
  at,
  projectId,
  writes,
  onClose,
  onCreated,
}: {
  column: Column;
  at: "top" | "bottom";
  projectId: string;
  writes: BoardWrites;
  onClose: () => void;
  onCreated: (title: string) => void;
}) {
  return (
    <InlineComposer
      aria-label={`New task in ${column.name}`}
      placeholder="Task title"
      submitLabel="Add task"
      keepOpen
      onCancel={onClose}
      onSubmit={async (title) => {
        await writes.create({ id: newTaskId(), title, projectId, laneId: column.laneIds[0]!, placement: at });
        onCreated(title);
      }}
      className={at === "top" ? "" : "mt-1"}
    />
  );
}

function AddLane({ board, projectId }: { board: BoardData; projectId: string }) {
  return <LaneMenu board={board} projectId={projectId} laneId={null} />;
}
