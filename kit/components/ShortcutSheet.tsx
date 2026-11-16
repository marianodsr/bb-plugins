import { useMemo, useState, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "../../lib/utils";
import { usePortalScopeProps } from "../../lib/portal-scope";
import { useHotkeys, useRegisteredHotkeys } from "../hooks/useHotkeys";
import { useKitMotion } from "../motion";
import { Kbd, ShortcutHint } from "./Kbd";
import { formatCombo } from "../hooks/useHotkeys";

/**
 * The `?` list of every described shortcut currently registered through
 * `useHotkeys`, grouped. Place it once per page, usually in the header; it
 * renders a small `?` button that also opens it. Escape closes it and focus
 * returns where it was.
 *
 * ```tsx
 * <header>... <ShortcutSheet /></header>
 * ```
 */
export function ShortcutSheet({
  extra,
  className,
  trigger = true,
}: {
  /** Static rows to add, e.g. host shortcuts you rely on. */
  extra?: readonly { keys: readonly string[]; description: string; group?: string }[];
  className?: string;
  /** Render the `?` button. With false, only the `?` key opens it. */
  trigger?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const registered = useRegisteredHotkeys();
  const portal = usePortalScopeProps();
  const { variants } = useKitMotion();

  useHotkeys([{ key: "?", handler: () => setOpen((o) => !o), description: "Show shortcuts" }]);

  const groups = useMemo(() => {
    const rows = [
      ...registered,
      ...(extra ?? []).map((e) => ({ ...e, group: e.group ?? "General" })),
    ];
    const seen = new Set<string>();
    const map = new Map<string, { keys: readonly string[]; description: string }[]>();
    for (const row of rows) {
      const id = `${row.group}|${row.description}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const list = map.get(row.group) ?? [];
      list.push({ keys: row.keys, description: row.description });
      map.set(row.group, list);
    }
    return [...map.entries()];
  }, [registered, extra]);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      {trigger ? (
        <Popover.Trigger asChild>
          <button
            type="button"
            aria-label="Keyboard shortcuts"
            title="Keyboard shortcuts (?)"
            className={cn(
              "inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground",
              "transition-colors duration-[120ms] ease-out hover:bg-state-hover hover:text-foreground",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-state-active",
              className,
            )}
          >
            <Kbd className="border-none bg-transparent text-xs">?</Kbd>
          </button>
        </Popover.Trigger>
      ) : (
        <Popover.Anchor className={cn("inline-block size-0", className)} />
      )}
      <AnimatePresence>
        {open ? (
          <Popover.Portal forceMount>
            <Popover.Content
              {...portal}
              forceMount
              asChild
              align="end"
              sideOffset={6}
              collisionPadding={12}
              aria-label="Keyboard shortcuts"
            >
              <motion.div
                variants={variants.fadeScale}
                initial="hidden"
                animate="visible"
                exit="exit"
                style={{ transformOrigin: "var(--radix-popover-content-transform-origin)" }}
                className="z-50 max-h-[min(70vh,32rem)] w-[min(22rem,calc(100vw-24px))] overflow-y-auto rounded-xl border border-border bg-popover p-3 text-popover-foreground outline-none"
              >
                <div className="flex items-center justify-between pb-2">
                  <p className="text-sm font-medium">Keyboard shortcuts</p>
                  <ShortcutHint combo="Escape" label="to close" />
                </div>
                {groups.length === 0 ? (
                  <p className="py-2 text-sm text-muted-foreground">No shortcuts on this page.</p>
                ) : (
                  groups.map(([group, rows]) => (
                    <section key={group} className="pt-2">
                      <p className="pb-1 text-xs text-muted-foreground">{group}</p>
                      <ul>
                        {rows.map((row) => (
                          <li key={row.description} className="flex h-7 items-center justify-between gap-3 text-sm">
                            <span className="truncate">{row.description}</span>
                            <KeyList keys={row.keys} />
                          </li>
                        ))}
                      </ul>
                    </section>
                  ))
                )}
              </motion.div>
            </Popover.Content>
          </Popover.Portal>
        ) : null}
      </AnimatePresence>
    </Popover.Root>
  );
}

function KeyList({ keys }: { keys: readonly string[] }): ReactNode {
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {keys.map((combo, i) => (
        <span key={combo} className="flex items-center gap-1.5">
          {i > 0 ? <span className="text-xs text-muted-foreground">or</span> : null}
          <span className="flex items-center gap-0.5">
            {formatCombo(combo).map((part, j) => (
              <Kbd key={j}>{part}</Kbd>
            ))}
          </span>
        </span>
      ))}
    </span>
  );
}
