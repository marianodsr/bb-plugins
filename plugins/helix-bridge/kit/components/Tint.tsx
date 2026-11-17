// GENERATED from /kit by kit/scripts/sync.mjs (kit 36f976388355). Do not edit; change /kit and re-sync.
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

/**
 * Categorical hues from Tailwind's default palette (DESIGN.md "Colour").
 * Only for categories: labels, Jira status categories, comment severity.
 * State and chrome use host tokens instead.
 */
export const TINT_HUES = ["gray", "red", "orange", "amber", "yellow", "lime", "green", "emerald", "teal", "cyan", "sky", "blue", "indigo", "violet", "purple", "fuchsia", "pink", "rose"] as const;
export type TintHue = (typeof TINT_HUES)[number];

// Full class strings so Tailwind's scanner sees every one. `in-[.dark]:`
// follows bb's theme class; plain `dark:` would follow the OS instead.
export const TINT_CLASSES: Record<TintHue, string> = {
  gray: "bg-gray-500/15 text-gray-700 in-[.dark]:bg-gray-400/15 in-[.dark]:text-gray-300",
  red: "bg-red-500/15 text-red-700 in-[.dark]:bg-red-400/15 in-[.dark]:text-red-300",
  orange: "bg-orange-500/15 text-orange-700 in-[.dark]:bg-orange-400/15 in-[.dark]:text-orange-300",
  amber: "bg-amber-500/15 text-amber-700 in-[.dark]:bg-amber-400/15 in-[.dark]:text-amber-300",
  yellow: "bg-yellow-500/15 text-yellow-800 in-[.dark]:bg-yellow-400/15 in-[.dark]:text-yellow-300",
  lime: "bg-lime-500/15 text-lime-800 in-[.dark]:bg-lime-400/15 in-[.dark]:text-lime-300",
  green: "bg-green-500/15 text-green-700 in-[.dark]:bg-green-400/15 in-[.dark]:text-green-300",
  emerald: "bg-emerald-500/15 text-emerald-700 in-[.dark]:bg-emerald-400/15 in-[.dark]:text-emerald-300",
  teal: "bg-teal-500/15 text-teal-700 in-[.dark]:bg-teal-400/15 in-[.dark]:text-teal-300",
  cyan: "bg-cyan-500/15 text-cyan-700 in-[.dark]:bg-cyan-400/15 in-[.dark]:text-cyan-300",
  sky: "bg-sky-500/15 text-sky-700 in-[.dark]:bg-sky-400/15 in-[.dark]:text-sky-300",
  blue: "bg-blue-500/15 text-blue-700 in-[.dark]:bg-blue-400/15 in-[.dark]:text-blue-300",
  indigo: "bg-indigo-500/15 text-indigo-700 in-[.dark]:bg-indigo-400/15 in-[.dark]:text-indigo-300",
  violet: "bg-violet-500/15 text-violet-700 in-[.dark]:bg-violet-400/15 in-[.dark]:text-violet-300",
  purple: "bg-purple-500/15 text-purple-700 in-[.dark]:bg-purple-400/15 in-[.dark]:text-purple-300",
  fuchsia: "bg-fuchsia-500/15 text-fuchsia-700 in-[.dark]:bg-fuchsia-400/15 in-[.dark]:text-fuchsia-300",
  pink: "bg-pink-500/15 text-pink-700 in-[.dark]:bg-pink-400/15 in-[.dark]:text-pink-300",
  rose: "bg-rose-500/15 text-rose-700 in-[.dark]:bg-rose-400/15 in-[.dark]:text-rose-300",
};

export const TINT_DOT_CLASSES: Record<TintHue, string> = {
  gray: "bg-gray-500 in-[.dark]:bg-gray-400",
  red: "bg-red-500 in-[.dark]:bg-red-400",
  orange: "bg-orange-500 in-[.dark]:bg-orange-400",
  amber: "bg-amber-500 in-[.dark]:bg-amber-400",
  yellow: "bg-yellow-500 in-[.dark]:bg-yellow-400",
  lime: "bg-lime-500 in-[.dark]:bg-lime-400",
  green: "bg-green-500 in-[.dark]:bg-green-400",
  emerald: "bg-emerald-500 in-[.dark]:bg-emerald-400",
  teal: "bg-teal-500 in-[.dark]:bg-teal-400",
  cyan: "bg-cyan-500 in-[.dark]:bg-cyan-400",
  sky: "bg-sky-500 in-[.dark]:bg-sky-400",
  blue: "bg-blue-500 in-[.dark]:bg-blue-400",
  indigo: "bg-indigo-500 in-[.dark]:bg-indigo-400",
  violet: "bg-violet-500 in-[.dark]:bg-violet-400",
  purple: "bg-purple-500 in-[.dark]:bg-purple-400",
  fuchsia: "bg-fuchsia-500 in-[.dark]:bg-fuchsia-400",
  pink: "bg-pink-500 in-[.dark]:bg-pink-400",
  rose: "bg-rose-500 in-[.dark]:bg-rose-400",
};

/**
 * A low-alpha hue chip with same-hue text.
 *
 * ```tsx
 * <Tint hue="amber">Needs review</Tint>
 * <Tint hue={hueFor(label)} dot>{label}</Tint>
 * ```
 */
export function Tint({
  hue,
  children,
  dot = false,
  className,
  title,
}: {
  hue: TintHue;
  children: ReactNode;
  /** A leading dot, for lists where several chips sit together. */
  dot?: boolean;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      data-hue={hue}
      className={cn(
        "inline-flex h-5 max-w-full items-center gap-1.5 rounded-md px-1.5 text-xs font-medium whitespace-nowrap",
        TINT_CLASSES[hue],
        className,
      )}
    >
      {dot ? <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", TINT_DOT_CLASSES[hue])} /> : null}
      <span className="truncate">{children}</span>
    </span>
  );
}

/** A stable hue for free-form labels (same text, same hue, every time). */
export function hueFor(text: string, palette: readonly TintHue[] = LABEL_HUES): TintHue {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.toLowerCase().charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return palette[Math.abs(hash) % palette.length]!;
}

/** Hues that stay distinct from each other and from the status colours. */
export const LABEL_HUES: readonly TintHue[] = ["blue", "violet", "teal", "amber", "pink", "lime", "orange", "cyan", "fuchsia", "emerald"];
