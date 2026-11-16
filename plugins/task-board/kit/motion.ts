// GENERATED from /kit by kit/scripts/sync.mjs (kit 36f976388355). Do not edit; change /kit and re-sync.
// Motion tokens from docs/DESIGN.md ("Motion grammar"). Durations are in
// seconds because that is what `motion` takes; the `ms` table mirrors them for
// CSS and timers. Keep these in step with the custom properties in kit.css.
import { useReducedMotion, type Transition, type Variants } from "motion/react";

export const ms = {
  press: 120,
  enter: 200,
  exit: 140,
  handoff: 520,
  /** Opacity changes that survive `prefers-reduced-motion`. */
  reducedFade: 120,
  /** Loading shows nothing for this long, then skeletons. */
  loadingDelay: 150,
} as const;

export const ease = {
  /** `press`: hover, press, focus feedback. CSS `ease-out`. */
  press: [0, 0, 0.58, 1],
  /** `enter`: popovers, toolbars, blocks appearing. */
  enter: [0.22, 1, 0.36, 1],
  /** `exit`: the same things leaving. CSS `ease-in`. */
  exit: [0.42, 0, 1, 1],
} as const satisfies Record<string, readonly [number, number, number, number]>;

export const spring = {
  /** Layout changes, list reorder, panels. */
  shift: { type: "spring", stiffness: 520, damping: 38, mass: 0.9 },
  /** Drag pick-up and drop. */
  lift: { type: "spring", stiffness: 380, damping: 26, mass: 0.8 },
  /** The handoff packet only. */
  handoff: { type: "spring", stiffness: 260, damping: 30 },
} as const satisfies Record<string, Transition>;

export type MotionToken = "press" | "enter" | "exit" | "shift" | "lift" | "handoff";

export const transitions: Record<MotionToken, Transition> = {
  press: { duration: ms.press / 1000, ease: [...ease.press] },
  enter: { duration: ms.enter / 1000, ease: [...ease.enter] },
  exit: { duration: ms.exit / 1000, ease: [...ease.exit] },
  shift: spring.shift,
  lift: spring.lift,
  handoff: spring.handoff,
};

/** Under reduced motion every token collapses to this opacity fade. */
export const reducedFade: Transition = {
  duration: ms.reducedFade / 1000,
  ease: "linear",
};

/**
 * Shared variants. Use with `initial="hidden" animate="visible" exit="exit"`.
 * Pair list items with `layout` and `transition={transition("shift")}`.
 */
type KitVariants = Record<"fadeScale" | "collapse" | "listItem", Variants>;

export const variants: KitVariants = {
  fadeScale: {
    hidden: { opacity: 0, scale: 0.96 },
    visible: { opacity: 1, scale: 1, transition: transitions.enter },
    exit: { opacity: 0, scale: 0.98, transition: transitions.exit },
  },
  /** Grid-rows collapse: wrap content in a `min-h-0 overflow-hidden` child. */
  collapse: {
    hidden: { gridTemplateRows: "0fr", opacity: 0 },
    visible: { gridTemplateRows: "1fr", opacity: 1, transition: { ...spring.shift } },
    exit: { gridTemplateRows: "0fr", opacity: 0, transition: transitions.exit },
  },
  listItem: {
    hidden: { opacity: 0, y: -4 },
    visible: { opacity: 1, y: 0, transition: transitions.enter },
    exit: { opacity: 0, scale: 0.98, transition: transitions.exit },
  },
};

/** The same variants with travel and scale removed. */
export const reducedVariants: KitVariants = {
  fadeScale: {
    hidden: { opacity: 0 },
    visible: { opacity: 1, transition: reducedFade },
    exit: { opacity: 0, transition: reducedFade },
  },
  collapse: {
    hidden: { gridTemplateRows: "0fr", opacity: 0 },
    visible: { gridTemplateRows: "1fr", opacity: 1, transition: { duration: 0 } },
    exit: { gridTemplateRows: "0fr", opacity: 0, transition: { duration: 0 } },
  },
  listItem: {
    hidden: { opacity: 0 },
    visible: { opacity: 1, transition: reducedFade },
    exit: { opacity: 0, transition: reducedFade },
  },
};

/**
 * Motion for the current user preference.
 *
 * ```tsx
 * const { transition, variants } = useKitMotion();
 * <motion.li layout transition={transition("shift")} variants={variants.listItem} />
 * ```
 */
export function useKitMotion() {
  const reduced = useReducedMotion() ?? false;
  return {
    reduced,
    transition: (token: MotionToken): Transition =>
      reduced ? reducedFade : transitions[token],
    variants: reduced ? reducedVariants : variants,
  };
}

/** Non-hook check, for imperative code paths (event handlers, timers). */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}
