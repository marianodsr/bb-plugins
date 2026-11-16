// The shared design kit. Generated copies live in plugins/<id>/kit/; edit the
// source in /kit and run `node kit/scripts/sync.mjs`. See kit/README.md.
import "./kit.css";

export {
  ms,
  ease,
  spring,
  transitions,
  reducedFade,
  variants,
  reducedVariants,
  useKitMotion,
  prefersReducedMotion,
  type MotionToken,
} from "./motion";

export {
  useHotkeys,
  useRegisteredHotkeys,
  isTypingTarget,
  formatCombo,
  type Hotkey,
  type UseHotkeysOptions,
} from "./hooks/useHotkeys";
export { useContainerWidth } from "./hooks/useContainerWidth";

export { Kbd, ShortcutHint, shortcutLabel } from "./components/Kbd";
export { ShortcutSheet } from "./components/ShortcutSheet";
export { Segmented, type SegmentedOption } from "./components/Segmented";
export { StatusDot, threadRunStatus, runStatusLabel, type RunStatus } from "./components/StatusDot";
export { ThreadChip, useLiveThread } from "./components/ThreadChip";
export { Collapse } from "./components/Collapse";
export { Skeleton, SkeletonRows, ProgressLine } from "./components/Loading";
export { EmptyState } from "./components/EmptyState";
export {
  Tint,
  hueFor,
  TINT_HUES,
  TINT_CLASSES,
  TINT_DOT_CLASSES,
  LABEL_HUES,
  type TintHue,
} from "./components/Tint";
export { InlineComposer } from "./components/InlineComposer";

export { useHandoff, type Handoff, type HandoffPhase, type UseHandoffOptions } from "./handoff/useHandoff";
export { HandoffSheet } from "./handoff/HandoffSheet";
export { SentChip } from "./handoff/SentChip";
export type {
  HandoffTarget,
  HandoffResult,
  HandoffDelivery,
  HandoffThread,
  HandoffTransport,
  JsonObject,
} from "./handoff/types";
