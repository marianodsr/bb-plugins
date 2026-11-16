import { cn } from "../../lib/utils";

/**
 * A placeholder block. Invisible for the first 150 ms, so fast loads show
 * nothing; then it breathes slowly. Size it like the content it stands for.
 *
 * ```tsx
 * <Skeleton className="h-4 w-48" />
 * ```
 */
export function Skeleton({ className }: { className?: string }) {
  // One element, so width classes (`w-2/5`, `flex-1`, `col-span-2`) size the
  // flex or grid item itself. The 150 ms delay lives in the same animation.
  return <span aria-hidden className={cn("kit-skeleton block h-4 shrink-0 rounded-md", className)} />;
}

/**
 * Skeleton list rows matching kit list density: 32 px rows (28 px dense)
 * with a lead mark, a title and optional trailing meta.
 */
export function SkeletonRows({
  count = 5,
  dense = false,
  className,
}: {
  count?: number;
  dense?: boolean;
  className?: string;
}) {
  const widths = ["w-3/5", "w-2/5", "w-1/2", "w-2/3", "w-1/3"];
  return (
    <div role="status" aria-label="Loading" className={cn("flex flex-col", className)}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={cn("flex items-center gap-3 px-3", dense ? "h-7" : "h-8")}>
          <Skeleton className="size-3 shrink-0 rounded-full" />
          <Skeleton className={cn("h-3 shrink", widths[i % widths.length])} />
          <span className="flex-1" />
          <Skeleton className="h-3 w-10" />
        </div>
      ))}
    </div>
  );
}

/**
 * The 2 px background-refresh line. Place it inside a `relative` header; it
 * sits on the header's bottom edge. Appears after 150 ms, so quick refreshes
 * never flicker.
 *
 * ```tsx
 * <header className="relative ...">... <ProgressLine active={isFetching} /></header>
 * ```
 */
export function ProgressLine({ active, className }: { active: boolean; className?: string }) {
  return (
    <div
      role="progressbar"
      aria-hidden={!active}
      aria-label="Refreshing"
      className={cn(
        "pointer-events-none absolute inset-x-0 bottom-0 h-0.5 overflow-hidden transition-opacity",
        active
          ? "opacity-100 delay-150 duration-200 ease-out"
          : "opacity-0 delay-0 duration-[140ms] ease-in",
        className,
      )}
    >
      {active ? <div className="kit-progress-bar h-full w-2/5 rounded-full bg-foreground/45" /> : null}
    </div>
  );
}
