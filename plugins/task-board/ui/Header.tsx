// The board page's header actions: project, search, filters, view, shortcuts.
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import * as Popover from "@radix-ui/react-popover";
import { useBbNavigate, useSdk } from "@get-bb/plugin-sdk/app";
import { AnimatePresence, motion } from "motion/react";
import { Kbd, Segmented, ShortcutSheet, Tint, hueFor, shortcutLabel, useHotkeys, useKitMotion } from "../kit";
import { Icon } from "../components/ui/icon";
import { usePortalScopeProps } from "../lib/portal-scope";
import { cn } from "../lib/utils";
import { PRIORITIES, type Priority } from "../src/schemas";
import { useBoard } from "./data";
import { allLabels, isFiltering, NO_FILTERS, routePath } from "./model";
import { registerSearch, setFilters, setView, useView, type ViewMode } from "./store";

export function useProjects() {
  const sdk = useSdk();
  const [projects, setProjects] = useState<Array<{ id: string; name: string }> | null>(null);
  useEffect(() => {
    let live = true;
    sdk.projects.list().then(
      (rows) => live && setProjects(rows.map((row) => ({ id: row.id, name: row.name }))),
      () => live && setProjects([]),
    );
    return () => {
      live = false;
    };
  }, [sdk]);
  return projects;
}

function PopoverBody({ children, className, align = "end" }: { children: React.ReactNode; className?: string; align?: "start" | "end" }) {
  const portal = usePortalScopeProps();
  const { variants } = useKitMotion();
  return (
    <Popover.Portal forceMount>
      <Popover.Content {...portal} forceMount asChild align={align} sideOffset={6} collisionPadding={12}>
        <motion.div
          variants={variants.fadeScale}
          initial="hidden"
          animate="visible"
          exit="exit"
          style={{ transformOrigin: "var(--radix-popover-content-transform-origin)" }}
          className={cn(
            "z-50 rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-lg outline-none",
            className,
          )}
        >
          {children}
        </motion.div>
      </Popover.Content>
    </Popover.Portal>
  );
}

const triggerClass =
  "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-sm hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-state-active";

function moveFocus(event: ReactKeyboardEvent, container: HTMLElement | null) {
  const items = Array.from(container?.querySelectorAll<HTMLElement>("[role=menuitemradio],[role=menuitemcheckbox]") ?? []);
  const index = items.indexOf(document.activeElement as HTMLElement);
  if (event.key === "ArrowDown" || event.key === "j") {
    event.preventDefault();
    items[Math.min(items.length - 1, index + 1)]?.focus();
  } else if (event.key === "ArrowUp" || event.key === "k") {
    event.preventDefault();
    items[Math.max(0, index - 1)]?.focus();
  }
}

function ProjectPicker({ scope, compact }: { scope: string | null; compact: boolean }) {
  const projects = useProjects();
  const navigate = useBbNavigate();
  const [open, setOpen] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const current = scope === "all" ? "All projects" : projects?.find((project) => project.id === scope)?.name ?? "";
  useHotkeys([{ key: "p", handler: () => setOpen(true), description: "Switch project", group: "Board" }]);
  const pick = (next: string) => {
    setOpen(false);
    setView({ scope: next, filters: NO_FILTERS });
    navigate.toPluginPanel("board", { subPath: routePath(next, null) });
  };
  const options = [...(projects ?? []).map((project) => ({ id: project.id, name: project.name })), { id: "all", name: "All projects" }];
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" className={cn(triggerClass, "min-w-0 font-medium", compact ? "max-w-28" : "max-w-44")} title={`Switch project (${shortcutLabel("p")})`}>
          <span className="truncate">{current || "Project"}</span>
          <Icon name="ChevronDown" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        </button>
      </Popover.Trigger>
      <AnimatePresence>
        {open ? (
          <PopoverBody align="start" className="w-60">
            <div
              ref={list}
              role="menu"
              aria-label="Projects"
              onKeyDown={(event) => moveFocus(event, list.current)}
              className="flex max-h-80 flex-col overflow-y-auto"
            >
              {options.map((option, index) => (
                <button
                  key={option.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={option.id === scope}
                  autoFocus={option.id === scope || (scope === null && index === 0)}
                  onClick={() => pick(option.id)}
                  className={cn(
                    "flex h-8 items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-state-hover focus-visible:bg-state-hover focus-visible:outline-none",
                    option.id === "all" && "mt-1 border-t border-border/60 pt-1",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{option.name}</span>
                  {option.id === scope ? <Icon name="Check" className="size-3.5" aria-hidden /> : null}
                </button>
              ))}
            </div>
          </PopoverBody>
        ) : null}
      </AnimatePresence>
    </Popover.Root>
  );
}

function SearchField() {
  const { filters } = useView();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    registerSearch(() => input.current?.focus());
    return () => registerSearch(null);
  }, []);
  return (
    <label className="relative flex h-7 w-full min-w-0 items-center">
      <Icon name="Search" className="pointer-events-none absolute left-2 size-3.5 text-muted-foreground" aria-hidden />
      <input
        ref={input}
        type="search"
        value={filters.query}
        onChange={(event) => setFilters({ query: event.target.value })}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            if (filters.query) setFilters({ query: "" });
            else input.current?.blur();
          }
        }}
        placeholder="Search"
        aria-label="Search tasks"
        aria-keyshortcuts="/"
        className="h-7 w-full min-w-0 rounded-md border border-input bg-background pl-7 pr-7 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-search-cancel-button]:hidden"
      />
      {!filters.query ? <Kbd className="pointer-events-none absolute right-1.5">/</Kbd> : null}
    </label>
  );
}

const PRIORITY_LABELS: Record<Priority, string> = { none: "No priority", low: "Low", medium: "Medium", high: "High", urgent: "Urgent" };

function FilterMenu({ scope, compact }: { scope: string | null; compact: boolean }) {
  const { filters } = useView();
  const board = useBoard(scope);
  const labels = allLabels(board.data?.tasks ?? []);
  const [open, setOpen] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const active =
    filters.labels.length + filters.priorities.length + (filters.withThreads ? 1 : 0);
  const toggle = <T,>(values: T[], value: T) => (values.includes(value) ? values.filter((row) => row !== value) : [...values, value]);
  useHotkeys([{ key: "f", handler: () => setOpen(true), description: "Filter", group: "Board" }]);
  const item = (checked: boolean, onClick: () => void, children: React.ReactNode, key: string) => (
    <button
      key={key}
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      onClick={onClick}
      className="flex h-8 items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-state-hover focus-visible:bg-state-hover focus-visible:outline-none"
    >
      <span
        className={cn(
          "grid size-3.5 shrink-0 place-items-center rounded-[4px] border border-input",
          checked && "border-foreground bg-foreground text-background",
        )}
      >
        {checked ? <Icon name="Check" className="size-2.5" aria-hidden /> : null}
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  );
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" className={triggerClass} title={`Filter (${shortcutLabel("f")})`} aria-label="Filter tasks">
          <Icon name="Filter" className="size-3.5 text-muted-foreground" aria-hidden />
          {active > 0 ? <span className="text-xs tabular-nums">{active}</span> : compact ? null : <span>Filter</span>}
        </button>
      </Popover.Trigger>
      <AnimatePresence>
        {open ? (
          <PopoverBody className="w-64">
            <div
              ref={list}
              role="menu"
              aria-label="Filters"
              onKeyDown={(event) => moveFocus(event, list.current)}
              className="flex max-h-96 flex-col overflow-y-auto"
            >
              {item(filters.withThreads, () => setFilters({ withThreads: !filters.withThreads }), "Has a thread", "threads")}
              <p className="px-2 pb-1 pt-2 text-xs text-muted-foreground">Priority</p>
              {PRIORITIES.filter((priority) => priority !== "none").map((priority) =>
                item(
                  filters.priorities.includes(priority),
                  () => setFilters({ priorities: toggle(filters.priorities, priority) }),
                  PRIORITY_LABELS[priority],
                  priority,
                ),
              )}
              {labels.length > 0 ? <p className="px-2 pb-1 pt-2 text-xs text-muted-foreground">Labels</p> : null}
              {labels.map((label) =>
                item(
                  filters.labels.includes(label),
                  () => setFilters({ labels: toggle(filters.labels, label) }),
                  <Tint hue={hueFor(label)}>{label}</Tint>,
                  `label:${label}`,
                ),
              )}
              {isFiltering({ ...filters, query: "" }) ? (
                <button
                  type="button"
                  onClick={() => setFilters({ labels: [], priorities: [], withThreads: false })}
                  className="mt-1 h-8 rounded-md border-t border-border/60 px-2 text-left text-sm text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none"
                >
                  Clear filters
                </button>
              ) : null}
            </div>
          </PopoverBody>
        ) : null}
      </AnimatePresence>
    </Popover.Root>
  );
}

const VIEW_OPTIONS = [
  { value: "board" as const, label: "Board", title: "Board (V)" },
  { value: "list" as const, label: "List", title: "List (V)" },
];

export function BoardHeader() {
  const { scope, view, pageWidth } = useView();
  useHotkeys([
    { key: "v", handler: () => setView({ view: view === "board" ? "list" : "board" }), description: "Switch board and list", group: "Board" },
  ]);
  // Tiers by the page's own width (the host shrink-wraps header content, and
  // the task panel can take half the page): wide shows everything, medium
  // drops labels, narrow leaves the view switch to its V key.
  const tier = pageWidth >= 1000 ? "wide" : pageWidth >= 700 ? "medium" : "narrow";
  return (
    <div className="flex min-w-0 items-center gap-1 pl-2">
      <ProjectPicker scope={scope} compact={tier !== "wide"} />
      <div className={tier === "wide" ? "w-48" : tier === "medium" ? "w-36" : "w-28"}>
        <SearchField />
      </div>
      <FilterMenu scope={scope} compact={tier !== "wide"} />
      {tier !== "narrow" ? (
        <Segmented<ViewMode> aria-label="View" value={view} onChange={(next) => setView({ view: next })} options={VIEW_OPTIONS} />
      ) : null}
      <ShortcutSheet />
    </div>
  );
}
