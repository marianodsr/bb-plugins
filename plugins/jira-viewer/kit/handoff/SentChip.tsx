// GENERATED from /kit by kit/scripts/sync.mjs (kit 36f976388355). Do not edit; change /kit and re-sync.
import { AnimatePresence, motion } from "motion/react";
import { useKitMotion } from "../motion";
import { ThreadChip } from "../components/ThreadChip";
import type { HandoffResult } from "./types";

/**
 * "Sent to <thread>": where the work went, as a chip that opens that thread.
 * Render it where the handoff started (the tray), keyed on the latest result;
 * it fades and scales in, and only cross-fades under reduced motion.
 *
 * ```tsx
 * <SentChip result={handoff.lastResult} />
 * ```
 */
export function SentChip({ result, className }: { result: HandoffResult | null; className?: string }) {
  const { variants } = useKitMotion();
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      {result ? (
        <motion.span
          key={result.at}
          variants={variants.fadeScale}
          initial="hidden"
          animate="visible"
          exit="exit"
          className="inline-flex min-w-0"
          role="status"
        >
          <ThreadChip
            threadId={result.threadId}
            title={result.threadTitle}
            prefix={result.delivery === "inserted" ? "Drafted in" : "Sent to"}
            className={className}
          />
        </motion.span>
      ) : null}
    </AnimatePresence>
  );
}
