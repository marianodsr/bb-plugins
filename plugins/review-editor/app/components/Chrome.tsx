// The editor's quiet chrome: file header, banners, the selection toolbar,
// and the loading skeleton.
import type { ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { Kbd, ProgressLine, Segmented, ShortcutSheet, Skeleton, shortcutLabel, useKitMotion } from "../../kit";

export type ViewMode = "edit" | "diff";
export type DiffLayout = "unified" | "split";

export function FileHeader({
  path,
  dirty,
  saving,
  mode,
  onMode,
  diffAvailable,
  diffLayout,
  onDiffLayout,
  splitFits,
  refreshing,
  onSave,
  compact,
}: {
  path: string;
  dirty: boolean;
  saving: boolean;
  mode: ViewMode;
  onMode: (mode: ViewMode) => void;
  diffAvailable: boolean;
  diffLayout: DiffLayout;
  onDiffLayout: (layout: DiffLayout) => void;
  splitFits: boolean;
  refreshing: boolean;
  onSave: () => void;
  compact: boolean;
}) {
  const slash = path.lastIndexOf("/");
  const directory = slash === -1 ? "" : path.slice(0, slash + 1);
  const name = path.slice(slash + 1);
  return (
    <header className="relative flex h-10 shrink-0 items-center gap-2 border-b border-border/60 px-3">
      <div className="flex min-w-0 flex-1 items-center gap-1.5" title={path}>
        <span className="min-w-0 truncate font-mono text-xs">
          {compact ? null : <span className="text-muted-foreground">{directory}</span>}
          <span className="text-foreground">{name}</span>
        </span>
        <AnimatePresence initial={false}>
          {dirty ? (
            <motion.span
              key="dirty"
              initial={{ opacity: 0, scale: 0.6 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.6 }}
              transition={{ duration: 0.12 }}
              className="size-1.5 shrink-0 rounded-full bg-foreground/70"
              aria-label="Unsaved changes"
              role="img"
            />
          ) : null}
        </AnimatePresence>
      </div>
      {dirty || saving ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2"
          onClick={onSave}
          disabled={saving}
          aria-label={`Save (${shortcutLabel("mod+s")})`}
        >
          {saving ? "Saving" : "Save"}
          {compact ? null : <Kbd>{shortcutLabel("mod+s")}</Kbd>}
        </Button>
      ) : null}
      {mode === "diff" && splitFits ? (
        <Segmented
          aria-label="Diff layout"
          value={diffLayout}
          onChange={onDiffLayout}
          options={[
            { value: "unified", label: "Unified", title: "Unified (U)" },
            { value: "split", label: "Split", title: "Split (U)" },
          ]}
        />
      ) : null}
      <span title={diffAvailable ? undefined : "No git history for this file"}>
        <Segmented
          aria-label="View"
          value={diffAvailable ? mode : "edit"}
          onChange={(value) => (diffAvailable || value === "edit" ? onMode(value) : undefined)}
          options={[
            { value: "edit", label: "Edit", title: "Edit (E)" },
            { value: "diff", label: "Diff", title: diffAvailable ? "Diff against HEAD (D)" : "No git history for this file" },
          ]}
        />
      </span>
      <ShortcutSheet />
      <ProgressLine active={refreshing} />
    </header>
  );
}

export function Banner({
  tone = "neutral",
  children,
  actions,
}: {
  tone?: "neutral" | "warning";
  children: ReactNode;
  actions: ReactNode;
}) {
  const { variants, transition } = useKitMotion();
  return (
    <motion.div
      role="status"
      variants={variants.collapse}
      initial="hidden"
      animate="visible"
      exit="exit"
      transition={transition("shift")}
      className="overflow-hidden"
    >
      <div
        className={cn(
          "flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-1.5 text-sm",
          tone === "warning" ? "border-attention/40 bg-attention/10" : "border-border/60 bg-muted/50",
        )}
      >
        <Icon name={tone === "warning" ? "AlertTriangle" : "Info"} className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">{children}</span>
        <span className="flex items-center gap-1">{actions}</span>
      </div>
    </motion.div>
  );
}

export function SelectionToolbar({
  position,
  onComment,
}: {
  position: { left: number; top: number } | null;
  onComment: () => void;
}) {
  const { variants, transition } = useKitMotion();
  return (
    <AnimatePresence>
      {position === null ? null : (
        <motion.div
          key="toolbar"
          variants={variants.fadeScale}
          initial="hidden"
          animate="visible"
          exit="exit"
          transition={transition("enter")}
          style={{ left: position.left, top: position.top }}
          className="absolute z-20 origin-top-left"
          onMouseDown={(event) => event.preventDefault()}
        >
          <Button
            type="button"
            size="sm"
            className="h-7 gap-1.5 rounded-md px-2 shadow-lg"
            onClick={onComment}
            aria-label={`Comment (${shortcutLabel("mod+alt+m")})`}
          >
            <Icon name="MessageSquarePlus" className="size-3.5" />
            Comment
            <span className="text-[11px] opacity-70">{shortcutLabel("mod+alt+m")}</span>
          </Button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

const SKELETON_WIDTHS = [62, 38, 0, 74, 55, 81, 47, 0, 66, 29, 58, 70, 0, 44, 77, 52, 36, 63];

/** The editor's shape while the file loads: a gutter and ragged code lines. */
export function EditorSkeleton() {
  return (
    <div className="flex-1 overflow-hidden pt-2" aria-hidden>
      {SKELETON_WIDTHS.map((width, index) => (
        <div key={index} className="flex h-[1.6em] items-center font-mono text-sm">
          <span className="w-14 shrink-0" />
          {width === 0 ? null : (
            <span className="block" style={{ width: `${width}%`, maxWidth: 640 }}>
              <Skeleton className="h-3" />
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
