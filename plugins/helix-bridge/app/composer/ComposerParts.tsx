// Composer pieces for threads a Helix serves:
// - the position chip and toggle: while on, a "Helix position" pill is added
//   at the end of the draft at the moment of submit (never while typing), and
//   the server resolves it into one agent-only line (file, line, selection);
// - the "From Helix" receipt over the composer when a draft lands.
import { useEffect, useRef, useState } from "react";
import { experimental_usePluginId as usePluginId, useComposer, useSettings } from "@get-bb/plugin-sdk/app";
import { AnimatePresence, motion } from "motion/react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { useKitMotion } from "../../kit";
import { useThreadHelix, whereLabel } from "../data";
import { useArrival } from "../stores";

export const POSITION_PROVIDER = "position";
const PILL_LABEL = "Helix position";
const RECEIPT_MS = 6000;

type Draft = ReturnType<typeof useComposer>["draft"];
type Mention = Draft["mentions"][number];

function isPositionPill(mention: Mention, pluginId: string): boolean {
  return mention.kind === "plugin" && mention.pluginId === pluginId && mention.provider === POSITION_PROVIDER;
}

/** The draft without this plugin's position pills; other mentions shift left. */
export function withoutPositionPills(draft: Draft, pluginId: string): Draft {
  let text = draft.text;
  const kept: Mention[] = [];
  const removed = draft.mentions.filter((m) => isPositionPill(m, pluginId)).sort((a, b) => b.from - a.from);
  for (const m of removed) {
    const end = text[m.to] === " " ? m.to + 1 : m.to;
    text = text.slice(0, m.from) + text.slice(end);
  }
  for (const m of draft.mentions) {
    if (isPositionPill(m, pluginId)) continue;
    const shift = removed.filter((r) => r.to <= m.from).reduce((n, r) => n + (r.to - r.from) + (draft.text[r.to] === " " ? 1 : 0), 0);
    kept.push({ ...m, from: m.from - shift, to: m.to - shift });
  }
  return { ...draft, text: text.trimEnd(), mentions: kept };
}

function storageKey(pluginId: string, threadId: string) {
  return `${pluginId}.positionInMessages.${threadId}`;
}

/** This thread's toggle, remembered in this browser; storage may be unavailable. */
function readToggle(key: string): boolean | null {
  try {
    const stored = window.localStorage.getItem(key);
    return stored === null ? null : stored === "1";
  } catch {
    return null;
  }
}

function writeToggle(key: string, on: boolean): void {
  try {
    window.localStorage.setItem(key, on ? "1" : "0");
  } catch {
    // not remembered; the default applies next time
  }
}

/** Whether a keydown on the composer is the plain Enter that submits it. */
export function isSubmitKey(event: Pick<KeyboardEvent, "key" | "shiftKey" | "altKey" | "isComposing">, menuOpen: boolean): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.altKey && !event.isComposing && !menuOpen;
}

/** bb's send, queue and steer buttons. */
function isSendButton(button: HTMLElement): boolean {
  const label = `${button.getAttribute("aria-label") ?? ""} ${button.getAttribute("title") ?? ""}`;
  return button.getAttribute("type") === "submit" || /^(send|queue|steer)\b/iu.test(label.trim());
}

/** The composer's own element: the nearest ancestor holding its editor. */
function composerRoot(from: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = from;
  for (let i = 0; node && i < 8; i += 1, node = node.parentElement) {
    if (node.matches("[data-promptbox-layout]") || node.querySelector('[contenteditable="true"]')) return node;
  }
  return null;
}

/**
 * The editor position, shown as a chip above the composer with its toggle.
 * The draft is the user's alone while they type: the "Helix position" pill
 * is appended only at the moment of submit (Enter or the send button), and
 * the server resolves it into one agent-only line.
 */
export function PositionChip() {
  const composer = useComposer();
  const pluginId = usePluginId();
  const { values } = useSettings();
  const threadId = composer.scope.kind === "thread" ? composer.scope.threadId : null;
  const { data, position } = useThreadHelix(threadId);
  const serving = data?.instance?.status === "connected";
  const fallback = values?.positionInMessages !== false;
  const [on, setOn] = useState<boolean>(() => (threadId ? (readToggle(storageKey(pluginId, threadId)) ?? fallback) : fallback));
  const chip = useRef<HTMLDivElement>(null);
  const focus = data?.instance?.focus ?? null;
  const where = position ? whereLabel(position.path, position.line, position.endLine) : whereLabel(focus?.path, focus?.line, focus?.endLine);

  useEffect(() => {
    const element = chip.current;
    if (!element || !threadId || !serving || !on) return;
    const root = composerRoot(element);
    if (!root) return;
    const attach = () => {
      if (composer.isEmpty || composer.draft.mentions.some((m) => isPositionPill(m, pluginId))) return;
      composer.insert([" ", { provider: POSITION_PROVIDER, id: threadId, label: PILL_LABEL }], { at: "end" });
    };
    const menuOpen = () => Boolean(document.querySelector('[role="listbox"]:not([hidden]), [cmdk-list]'));
    const onKeyDown = (event: KeyboardEvent) => {
      if (isSubmitKey(event, menuOpen())) attach();
    };
    const onPointerDown = (event: Event) => {
      const button = (event.target as HTMLElement | null)?.closest?.("button");
      if (button && root.contains(button) && isSendButton(button)) attach();
    };
    root.addEventListener("keydown", onKeyDown, true);
    root.addEventListener("pointerdown", onPointerDown, true);
    root.addEventListener("click", onPointerDown, true);
    return () => {
      root.removeEventListener("keydown", onKeyDown, true);
      root.removeEventListener("pointerdown", onPointerDown, true);
      root.removeEventListener("click", onPointerDown, true);
    };
  }, [composer, threadId, serving, on, pluginId]);

  if (!threadId || !serving) return null;
  const toggle = () => {
    const next = !on;
    setOn(next);
    writeToggle(storageKey(pluginId, threadId), next);
  };
  return (
    <div ref={chip} className="flex px-1 pb-1">
      <button
        type="button"
        aria-pressed={on}
        onClick={toggle}
        title={on ? "Your Helix file and line go with each message you send. Click to stop." : "Click to send your Helix file and line with each message."}
        className={cn(
          "inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors duration-[120ms] ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          on ? "border-border/60 bg-card text-foreground" : "border-dashed border-border/60 text-muted-foreground hover:text-foreground",
        )}
        data-helix-position={on ? "on" : "off"}
      >
        <Icon name="Target" className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-muted-foreground">{on ? "Sending position" : "Position off"}</span>
        {where ? <span className={cn("truncate font-mono", on ? "" : "line-through decoration-muted-foreground/60")}>{where}</span> : null}
      </button>
    </div>
  );
}

/** "From Helix <file:lines>" over the composer for a few seconds after a draft lands. */
export function FromHelixReceipt() {
  const composer = useComposer();
  const threadId = composer.scope.kind === "thread" ? composer.scope.threadId : null;
  const arrival = useArrival(threadId);
  const { variants } = useKitMotion();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!arrival) return;
    const left = arrival.at + RECEIPT_MS - Date.now();
    if (left <= 0) return;
    const timer = window.setTimeout(() => setNow(Date.now()), left + 10);
    return () => window.clearTimeout(timer);
  }, [arrival]);
  const showing = arrival && now - arrival.at < RECEIPT_MS && Date.now() - arrival.at < RECEIPT_MS;
  return (
    <AnimatePresence initial={false}>
      {showing ? (
        <motion.div key={arrival.at} variants={variants.fadeScale} initial="hidden" animate="visible" exit="exit" className="flex px-1 pb-1" role="status">
          <span className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border border-border/60 bg-card px-2.5 text-xs">
            <Icon name="Code" className="size-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">From Helix</span>
            <span className="truncate font-mono text-foreground">{arrival.summary}</span>
          </span>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
