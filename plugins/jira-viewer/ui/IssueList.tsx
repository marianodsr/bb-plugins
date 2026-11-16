// The dense, scannable list: rows grouped by status category, 32 px each.
// Rows animate insert, remove and reorder (not on first paint), and a row
// whose issue changed flashes its background once.
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, type RefObject } from "react";
import { Button } from "../components/ui/button";
import { useKitMotion } from "../kit";
import { LIST_LIMIT_MAX } from "../src/contract";
import type { IssueRow } from "../src/schemas";
import { changedKeys, groupIssues, snapshot } from "./logic";
import { IssueRowView } from "./parts";

export const PAGE_STEP = 50;

export function IssueList({
  issues,
  hasMore,
  limit,
  now,
  selectedKey,
  openKey,
  onSelect,
  onOpen,
  onLoadMore,
  rowRefs,
}: {
  issues: readonly IssueRow[];
  hasMore: boolean;
  limit: number;
  now: number;
  selectedKey: string | null;
  openKey: string | null;
  onSelect: (key: string) => void;
  onOpen: (key: string) => void;
  onLoadMore: () => void;
  rowRefs: RefObject<Map<string, HTMLButtonElement>>;
}) {
  const { transition, variants } = useKitMotion();
  const groups = useMemo(() => groupIssues(issues), [issues]);

  // Changed-row flash: compare `updated` with the previous render's snapshot.
  const previous = useRef<Map<string, string | null> | null>(null);
  const flashing = useMemo(() => changedKeys(previous.current, issues), [issues]);
  useEffect(() => {
    previous.current = snapshot(issues);
  }, [issues]);

  return (
    <div role="listbox" aria-label="Issues" className="flex flex-col pb-4">
      <AnimatePresence initial={false}>
        {groups.map((group) => (
          <motion.section
            key={group.category}
            layout="position"
            transition={transition("shift")}
            aria-label={`${group.label}, ${group.issues.length}`}
            className="flex flex-col"
          >
            <h3 className="sticky top-0 z-[1] flex h-8 items-end gap-2 bg-background px-3 pb-1.5 text-xs font-medium text-muted-foreground">
              {group.label}
              <span className="font-normal tabular-nums text-subtle-foreground">{group.issues.length}</span>
            </h3>
            <AnimatePresence initial={false}>
              {group.issues.map((issue) => (
                <motion.div
                  key={issue.key}
                  layout="position"
                  transition={transition("shift")}
                  variants={variants.listItem}
                  initial="hidden"
                  animate="visible"
                  exit="exit"
                  className="px-1.5"
                >
                  <IssueRowView
                    // Remount on change so the flash animation replays.
                    key={flashing.has(issue.key) ? `${issue.key}:${issue.updated}` : issue.key}
                    ref={(element) => {
                      if (element) rowRefs.current.set(issue.key, element);
                      else rowRefs.current.delete(issue.key);
                    }}
                    issue={issue}
                    now={now}
                    selected={selectedKey === issue.key}
                    open={openKey === issue.key}
                    flash={flashing.has(issue.key)}
                    onSelect={() => onSelect(issue.key)}
                    onOpen={() => onOpen(issue.key)}
                  />
                </motion.div>
              ))}
            </AnimatePresence>
          </motion.section>
        ))}
      </AnimatePresence>
      {hasMore ? (
        limit < LIST_LIMIT_MAX ? (
          <Button size="sm" variant="ghost" className="mx-3 mt-2 self-start px-2 text-muted-foreground" onClick={onLoadMore}>
            Show {Math.min(PAGE_STEP, LIST_LIMIT_MAX - limit)} more
          </Button>
        ) : (
          <p className="mx-3 mt-3 text-xs text-muted-foreground">
            Showing the first {LIST_LIMIT_MAX}. Narrow the search to see the rest.
          </p>
        )
      ) : null}
    </div>
  );
}
