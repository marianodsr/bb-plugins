// GENERATED from /kit by kit/scripts/sync.mjs (kit 36f976388355). Do not edit; change /kit and re-sync.
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { cn } from "../../lib/utils";

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Accessible name when `label` is an icon. */
  ariaLabel?: string;
  /** Shown as the button's tooltip, e.g. "Diff (D)". */
  title?: string;
  disabled?: boolean;
}

/**
 * A segmented control with a sliding thumb. Arrow keys move the selection.
 *
 * ```tsx
 * <Segmented aria-label="View" value={view} onChange={setView}
 *   options={[{ value: "edit", label: "Edit" }, { value: "diff", label: "Diff" }]} />
 * ```
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  size = "sm",
  className,
  "aria-label": ariaLabel,
}: {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: "sm" | "md";
  className?: string;
  "aria-label": string;
}) {
  const buttons = useRef(new Map<T, HTMLButtonElement>());
  const [thumb, setThumb] = useState<{ x: number; w: number } | null>(null);

  const measure = useCallback(() => {
    const el = buttons.current.get(value);
    if (!el) return;
    setThumb({ x: el.offsetLeft, w: el.offsetWidth });
  }, [value]);

  useLayoutEffect(() => {
    measure();
    const observer = new ResizeObserver(measure);
    buttons.current.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [measure, options]);

  const enabled = options.filter((o) => !o.disabled);
  const onKeyDown = (event: KeyboardEvent) => {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (step === 0) return;
    event.preventDefault();
    const index = enabled.findIndex((o) => o.value === value);
    const next = enabled[(index + step + enabled.length) % enabled.length];
    if (!next) return;
    onChange(next.value);
    buttons.current.get(next.value)?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className={cn(
        "relative inline-flex shrink-0 items-center rounded-md bg-muted p-0.5",
        size === "sm" ? "h-7" : "h-8",
        className,
      )}
    >
      {thumb ? (
        <span
          aria-hidden
          className="kit-segmented-thumb absolute top-0.5 bottom-0.5 left-0 rounded-[4px] border border-border/60 bg-background"
          style={{ transform: `translateX(${thumb.x}px)`, width: thumb.w }}
        />
      ) : null}
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            ref={(el) => {
              if (el) buttons.current.set(option.value, el);
              else buttons.current.delete(option.value);
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={option.ariaLabel}
            title={option.title}
            disabled={option.disabled}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(option.value)}
            className={cn(
              "relative z-[1] inline-flex h-full min-w-7 cursor-pointer items-center justify-center gap-1.5 rounded-[4px] px-2.5",
              "pointer-coarse:after:absolute pointer-coarse:after:inset-x-0 pointer-coarse:after:-inset-y-2 pointer-coarse:after:content-['']",
              "text-xs font-medium transition-colors duration-[120ms] ease-out",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              "disabled:cursor-default disabled:opacity-50",
              selected ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
