// GENERATED from /kit by kit/scripts/sync.mjs (kit 36f976388355). Do not edit; change /kit and re-sync.
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { formatCombo } from "../hooks/useHotkeys";

/** One key cap. Use `ShortcutHint` for a full combo such as `mod+enter`. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[4px] border border-border/80 bg-surface-raised px-1",
        "font-sans text-[11px] leading-none font-medium tabular-nums text-muted-foreground",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

/**
 * The key for an action, shown beside its control.
 *
 * ```tsx
 * <Button>Send to thread <ShortcutHint combo="s" /></Button>
 * <ShortcutHint combo="mod+enter" label="to send" />
 * ```
 */
export function ShortcutHint({
  combo,
  label,
  className,
}: {
  combo: string;
  /** Optional text after the keys, e.g. "to send". */
  label?: string;
  className?: string;
}) {
  return (
    <span
      className={cn("inline-flex items-center gap-1 text-xs text-muted-foreground", className)}
      aria-hidden={label ? undefined : true}
    >
      <span className="inline-flex items-center gap-0.5">
        {formatCombo(combo).map((part, i) => (
          <Kbd key={i}>{part}</Kbd>
        ))}
      </span>
      {label ? <span>{label}</span> : null}
    </span>
  );
}

/** Plain-text form for `title` and `aria-keyshortcuts`, e.g. "⌘Enter". */
export function shortcutLabel(combo: string): string {
  const parts = formatCombo(combo);
  return parts.every((p) => p.length === 1) ? parts.join("") : parts.join("+");
}
