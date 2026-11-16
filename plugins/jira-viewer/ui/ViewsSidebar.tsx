// Saved views, in the page's sidebar (it replaces the thread list while the
// page is open). Create, rename, edit JQL, delete with undo, and reorder
// with Alt+Arrow. Every write is optimistic.
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { toast } from "sonner";
import { Button } from "../components/ui/button";
import { Icon } from "../components/ui/icon";
import { Kbd, SkeletonRows, shortcutLabel, useHotkeys, useKitMotion } from "../kit";
import { cn } from "../lib/utils";
import type { View } from "../src/schemas";
import { parseSubPath, formatSubPath } from "./logic";
import { PANEL_PATH, moveViewId, useLastSource, useViewMutations, useViews } from "./rpc";

export function ViewsSidebar({ subPath }: { subPath: string }) {
  const navigate = useBbNavigate();
  const views = useViews();
  const mutations = useViewMutations();
  const { transition, variants } = useKitMotion();
  const [lastSource] = useLastSource();
  const route = useMemo(() => parseSubPath(subPath), [subPath]);
  const active = route.source ?? lastSource;
  const activeViewId = active?.kind === "view" ? active.viewId : null;
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const newViewRef = useRef<HTMLButtonElement>(null);
  // Focus returns to what opened a form once it closes.
  const refocus = (target: () => HTMLElement | null | undefined) =>
    window.requestAnimationFrame(() => target()?.focus({ preventScroll: true }));

  // Listed in the page's shortcut sheet (its `extra`), so no description here.
  useHotkeys([{ key: "n", handler: () => setCreating(true) }]);

  const list = views.data?.views ?? [];

  const openView = (id: string) => navigate.toPluginPanel(PANEL_PATH, { subPath: formatSubPath({ kind: "view", viewId: id }) });

  const remove = (view: View) => {
    const before = list.map((entry) => entry.id);
    const index = before.indexOf(view.id);
    void mutations.remove.mutate({ id: view.id }).catch((error: unknown) => {
      toast.error(`Not deleted: ${error instanceof Error ? error.message : String(error)}`);
    });
    if (activeViewId === view.id) openView(list.find((entry) => entry.id !== view.id)?.id ?? "my-open");
    toast(`Deleted view ${view.name}`, {
      action: {
        label: "Undo",
        onClick: () => {
          void (async () => {
            const restored = await mutations.create.mutate({ name: view.name, jql: view.jql });
            const ids = before.map((id) => (id === view.id ? restored.id : id));
            await mutations.reorder.mutate({ ids });
            if (index >= 0) toast.success(`Restored view ${view.name}`);
          })().catch((error: unknown) => {
            toast.error(`Not restored: ${error instanceof Error ? error.message : String(error)}`);
          });
        },
      },
    });
  };

  const reorderKey = (event: KeyboardEvent, view: View) => {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    event.preventDefault();
    const ids = moveViewId(
      list.map((entry) => entry.id),
      view.id,
      event.key === "ArrowUp" ? -1 : 1,
    );
    void mutations.reorder.mutate({ ids }).catch((error: unknown) => {
      toast.error(`Not moved: ${error instanceof Error ? error.message : String(error)}`);
    });
    window.requestAnimationFrame(() => rowRefs.current.get(view.id)?.focus());
  };

  return (
    <nav aria-label="Saved views" className="flex h-full min-h-0 flex-col gap-1 px-2 py-2">
      <div className="flex h-7 items-center px-2 text-xs font-medium text-muted-foreground">Views</div>
      {views.isLoading ? (
        <SkeletonRows count={3} dense />
      ) : (
        <ul className="flex flex-col">
          <AnimatePresence initial={false}>
            {list.map((view) => (
              <motion.li
                key={view.id}
                layout="position"
                transition={transition("shift")}
                variants={variants.listItem}
                initial="hidden"
                animate="visible"
                exit="exit"
              >
                {editing === view.id ? (
                  <ViewForm
                    initial={view}
                    submitLabel="Save"
                    onCancel={() => {
                      setEditing(null);
                      refocus(() => rowRefs.current.get(view.id));
                    }}
                    onSubmit={async (name, jql) => {
                      setEditing(null);
                      refocus(() => rowRefs.current.get(view.id));
                      try {
                        await mutations.update.mutate({ id: view.id, name, jql });
                      } catch (error) {
                        toast.error(`Not saved: ${error instanceof Error ? error.message : String(error)}`);
                      }
                    }}
                  />
                ) : (
                  <ViewRow
                    view={view}
                    active={activeViewId === view.id}
                    pending={view.id.startsWith("pending:")}
                    rowRef={(element) => {
                      if (element) rowRefs.current.set(view.id, element);
                      else rowRefs.current.delete(view.id);
                    }}
                    onOpen={() => openView(view.id)}
                    onEdit={() => setEditing(view.id)}
                    onDelete={() => remove(view)}
                    onKeyDown={(event) => reorderKey(event, view)}
                  />
                )}
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}
      {creating ? (
        <ViewForm
          submitLabel="Create view"
          onCancel={() => {
            setCreating(false);
            refocus(() => newViewRef.current);
          }}
          onSubmit={async (name, jql) => {
            setCreating(false);
            try {
              const view = await mutations.create.mutate({ name, jql });
              openView(view.id);
            } catch (error) {
              toast.error(`Not created: ${error instanceof Error ? error.message : String(error)}`);
            }
          }}
        />
      ) : (
        <button
          ref={newViewRef}
          type="button"
          onClick={() => setCreating(true)}
          title={`New view (${shortcutLabel("n")})`}
          className="flex h-7 items-center gap-2 rounded-md px-2 text-sm text-muted-foreground outline-none transition-colors duration-[120ms] hover:bg-state-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Icon name="Plus" className="size-3.5" />
          <span className="flex-1 text-left">New view</span>
          <Kbd>N</Kbd>
        </button>
      )}
    </nav>
  );
}

function ViewRow({
  view,
  active,
  pending,
  rowRef,
  onOpen,
  onEdit,
  onDelete,
  onKeyDown,
}: {
  view: View;
  active: boolean;
  pending: boolean;
  rowRef: (element: HTMLButtonElement | null) => void;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onKeyDown: (event: KeyboardEvent) => void;
}) {
  return (
    <div
      className={cn(
        "group/view flex h-7 items-center rounded-md transition-colors duration-[120ms]",
        active ? "bg-surface-selected" : "hover:bg-state-hover",
      )}
    >
      <button
        ref={rowRef}
        type="button"
        onClick={onOpen}
        onKeyDown={onKeyDown}
        disabled={pending}
        aria-current={active ? "page" : undefined}
        title={view.jql}
        className={cn(
          "flex h-7 min-w-0 flex-1 items-center rounded-md px-2 text-left text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring",
          active ? "font-medium text-foreground" : "text-foreground/85",
          pending && "opacity-60",
        )}
      >
        <span className="truncate">{view.name}</span>
      </button>
      <div className="mr-0.5 flex shrink-0 items-center opacity-0 transition-opacity duration-[120ms] focus-within:opacity-100 group-hover/view:opacity-100">
        <button
          type="button"
          onClick={onEdit}
          aria-label={`Edit ${view.name}`}
          title="Edit"
          className="flex size-6 items-center justify-center rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Icon name="Edit" className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={onDelete}
          aria-label={`Delete ${view.name}`}
          title="Delete"
          className="flex size-6 items-center justify-center rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Icon name="Trash2" className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

/** Name and JQL in place. Enter saves, Escape cancels. */
export function ViewForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: { name: string; jql: string };
  submitLabel: string;
  onSubmit: (name: string, jql: string) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [jql, setJql] = useState(initial?.jql ?? "");
  const valid = name.trim() !== "" && jql.trim() !== "";
  const escape = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    }
  };
  return (
    <form
      className="flex flex-col gap-1.5 rounded-lg border border-border/70 bg-card p-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) void onSubmit(name.trim(), jql.trim());
      }}
    >
      <input
        autoFocus
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={escape}
        placeholder="View name"
        aria-label="View name"
        maxLength={80}
        className="h-7 rounded-md bg-muted/60 px-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <textarea
        value={jql}
        onChange={(event) => setJql(event.target.value)}
        onKeyDown={(event) => {
          escape(event);
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            if (valid) void onSubmit(name.trim(), jql.trim());
          }
        }}
        placeholder="JQL, such as project = ENG ORDER BY updated DESC"
        aria-label="JQL"
        rows={3}
        maxLength={4000}
        spellCheck={false}
        className="resize-none rounded-md bg-muted/60 px-2 py-1.5 font-mono text-xs leading-5 outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <div className="flex items-center gap-1.5">
        <Button type="submit" size="sm" disabled={!valid} className="h-7">
          {submitLabel}
        </Button>
        <Button type="button" size="sm" variant="ghost" className="h-7 text-muted-foreground" onClick={onCancel}>
          Cancel
        </Button>
        <span className="flex-1" />
        <Kbd>Enter</Kbd>
      </div>
    </form>
  );
}
