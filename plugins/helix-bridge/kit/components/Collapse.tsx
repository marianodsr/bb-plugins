// GENERATED from /kit by kit/scripts/sync.mjs (kit 36f976388355). Do not edit; change /kit and re-sync.
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

/**
 * Show or hide content by animating `grid-template-rows` (never `height`).
 * Closed content is `inert`: not focusable, not read out.
 *
 * ```tsx
 * <Collapse open={expanded}><PromptPreview /></Collapse>
 * ```
 */
export function Collapse({
  open,
  children,
  className,
  id,
}: {
  open: boolean;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <div id={id} className={cn("kit-collapse", className)} data-open={open} inert={!open || undefined}>
      <div>{children}</div>
    </div>
  );
}
