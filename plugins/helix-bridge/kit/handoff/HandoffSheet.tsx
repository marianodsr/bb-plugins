// GENERATED from /kit by kit/scripts/sync.mjs (kit 36f976388355). Do not edit; change /kit and re-sync.
import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import * as Popover from "@radix-ui/react-popover";
import { Slot } from "@radix-ui/react-slot";
import { AnimatePresence, motion } from "motion/react";
import {
  experimental_NewThreadComposer as NewThreadComposer,
  type NewThreadRequest,
} from "@get-bb/plugin-sdk/app";
import { cn } from "../../lib/utils";
import { usePortalScopeProps } from "../../lib/portal-scope";
import { Button } from "../../components/ui/button";
import { Icon } from "../../components/ui/icon";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { useKitMotion } from "../motion";
import { useHotkeys } from "../hooks/useHotkeys";
import { Kbd, ShortcutHint, shortcutLabel } from "../components/Kbd";
import { StatusDot } from "../components/StatusDot";
import { Collapse } from "../components/Collapse";
import type { Handoff } from "./useHandoff";
import type { HandoffTarget } from "./types";

type Option =
  | { id: string; kind: "insert" }
  | { id: string; kind: "send-current" }
  | { id: string; kind: "thread"; threadId: string }
  | { id: string; kind: "new" };

const MAX_ROWS = 40;

/**
 * The Send to thread control and its sheet: target picker (this thread,
 * another thread, new thread), prompt preview, and the new-thread dialog.
 * The button is the packet's origin, so place it where the user acts (the
 * tray or toolbar). Pass `children` to use your own trigger element.
 *
 * ```tsx
 * <HandoffSheet handoff={handoff} />
 * <HandoffSheet handoff={handoff}><Button size="sm">Start work</Button></HandoffSheet>
 * ```
 */
export function HandoffSheet<T>({
  handoff,
  children,
  align = "end",
  side = "top",
  buttonLabel = "Send to thread",
  className,
}: {
  handoff: Handoff<T>;
  children?: ReactNode;
  align?: "start" | "center" | "end";
  side?: "top" | "bottom";
  buttonLabel?: string;
  className?: string;
}) {
  const portal = usePortalScopeProps();
  const { variants } = useKitMotion();
  const disabled = handoff.count === 0;

  useHotkeys(
    handoff.hotkey
      ? [
          {
            key: handoff.hotkey,
            handler: () => handoff.setOpen(!handoff.open),
            description: buttonLabel,
            enabled: !disabled,
          },
        ]
      : [],
  );

  return (
    <>
      <Popover.Root open={handoff.open} onOpenChange={handoff.setOpen}>
        <Popover.Trigger asChild disabled={disabled}>
          {children ? (
            <Slot ref={handoff.originRef}>{children}</Slot>
          ) : (
            <SendButton
              ref={handoff.originRef}
              disabled={disabled}
              hotkey={handoff.hotkey}
              label={buttonLabel}
              className={className}
            />
          )}
        </Popover.Trigger>
        <AnimatePresence>
          {handoff.open ? (
            <Popover.Portal forceMount>
              <Popover.Content
                {...portal}
                forceMount
                asChild
                side={side}
                align={align}
                sideOffset={8}
                collisionPadding={12}
                onOpenAutoFocus={(event) => event.preventDefault()}
              >
                <motion.div
                  variants={variants.fadeScale}
                  initial="hidden"
                  animate="visible"
                  exit="exit"
                  style={{ transformOrigin: "var(--radix-popover-content-transform-origin)" }}
                  className="z-50 flex max-h-[min(78vh,36rem)] w-[min(24rem,calc(100vw-24px))] flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground outline-none"
                >
                  <SheetBody handoff={handoff} />
                </motion.div>
              </Popover.Content>
            </Popover.Portal>
          ) : null}
        </AnimatePresence>
      </Popover.Root>
      <NewThreadDialog handoff={handoff} />
    </>
  );
}

const SendButton = forwardRef<
  HTMLButtonElement,
  { hotkey?: string; label: string } & ComponentPropsWithoutRef<"button">
>(function SendButton({ disabled, hotkey, label, className, ...rest }, ref) {
  return (
    <Button
      ref={ref}
      size="sm"
      disabled={disabled}
      title={hotkey ? `${label} (${shortcutLabel(hotkey)})` : label}
      aria-keyshortcuts={hotkey}
      className={cn("h-8 gap-2 pr-2", !hotkey && "pr-3", className)}
      {...rest}
    >
      <Icon name="ArrowUp" className="size-3.5" aria-hidden />
      {label}
      {hotkey ? (
        <Kbd className="border-background/25 bg-background/15 text-background/80">
          {shortcutLabel(hotkey)}
        </Kbd>
      ) : null}
    </Button>
  );
});

function SheetBody<T>({ handoff }: { handoff: Handoff<T> }) {
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [preview, setPreview] = useState(false);

  useEffect(() => {
    input.current?.focus();
  }, []);

  const current = handoff.currentThread;
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = q
      ? handoff.threads.filter(
          (t) => t.title.toLowerCase().includes(q) || t.projectName?.toLowerCase().includes(q),
        )
      : handoff.threads;
    return rows.slice(0, MAX_ROWS);
  }, [handoff.threads, query]);

  const options = useMemo<Option[]>(() => {
    const out: Option[] = [];
    if (current && !query) {
      if (handoff.canInsert) out.push({ id: "insert", kind: "insert" });
      out.push({ id: "send-current", kind: "send-current" });
    }
    for (const t of matches) out.push({ id: `t:${t.id}`, kind: "thread", threadId: t.id });
    out.push({ id: "new", kind: "new" });
    return out;
  }, [current, query, handoff.canInsert, matches]);

  const activeIndex = Math.min(active, options.length - 1);
  const activeOption = options[activeIndex];
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    const el = list.current?.querySelector(`[data-option-index="${activeIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const previewTarget: HandoffTarget =
    activeOption?.kind === "thread"
      ? { kind: "thread", threadId: activeOption.threadId }
      : activeOption?.kind === "insert" && current
        ? { kind: "current", threadId: current.id, mode: "insert" }
        : activeOption?.kind === "send-current" && current
          ? { kind: "current", threadId: current.id, mode: "send" }
          : { kind: "new" };
  const prompt = preview ? handoff.buildPrompt(previewTarget) : "";

  const run = (option: Option | undefined) => {
    if (!option) return;
    if (option.kind === "new") handoff.startNewThread();
    else if (option.kind === "thread")
      void handoff.send({ kind: "thread", threadId: option.threadId }).catch(() => {});
    else if (current)
      void handoff
        .send({ kind: "current", threadId: current.id, mode: option.kind === "insert" ? "insert" : "send" })
        .catch(() => {});
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const move = (delta: number) => {
      event.preventDefault();
      setActive((i) => (Math.min(i, options.length - 1) + delta + options.length) % options.length);
    };
    if (event.key === "ArrowDown" || (event.ctrlKey && event.key === "n")) move(1);
    else if (event.key === "ArrowUp" || (event.ctrlKey && event.key === "p")) move(-1);
    else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (event.metaKey || event.ctrlKey) handoff.startNewThread();
      else run(activeOption);
    } else if (event.key === "Tab" && !event.shiftKey && event.target === input.current) {
      // Tab toggles the preview; the list itself is driven by arrows.
      event.preventDefault();
      setPreview((p) => !p);
    }
  };

  const optionProps = (option: Option, index: number) => ({
    id: `${listId}-${option.id}`,
    role: "option" as const,
    "aria-selected": index === activeIndex,
    "data-option-index": index,
    "data-active": index === activeIndex || undefined,
    onMouseMove: () => setActive(index),
    onClick: () => run(option),
  });
  const rowClass =
    "flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-md px-2 text-left text-sm outline-none data-[active]:bg-state-hover pointer-coarse:h-11";

  let index = -1;
  return (
    <div className="flex min-h-0 flex-col" onKeyDown={onKeyDown}>
      <div className="flex items-center justify-between gap-3 px-3 pt-3 pb-2">
        <p className="text-sm font-medium">
          Send <span className="tabular-nums">{handoff.label}</span>
        </p>
        <ShortcutHint combo="Escape" label="to close" />
      </div>
      <div className="px-3 pb-2">
        <div className="flex h-8 items-center gap-2 rounded-md border border-border bg-background px-2 focus-within:border-ring/50">
          <Icon name="Search" className="size-3.5 text-muted-foreground" aria-hidden />
          <input
            ref={input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search threads"
            aria-label="Search threads"
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={activeOption ? `${listId}-${activeOption.id}` : undefined}
            className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
      </div>
      <div
        ref={list}
        id={listId}
        role="listbox"
        aria-label="Targets"
        className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5"
      >
        {current && !query ? (
          <Group label="This thread" detail={current.title}>
            {handoff.canInsert ? (
              <div {...optionProps(options[++index]!, index)} className={rowClass}>
                <Icon name="Edit" className="size-4 text-muted-foreground" aria-hidden />
                <span className="flex-1">Insert into composer</span>
              </div>
            ) : null}
            <div {...optionProps(options[++index]!, index)} className={rowClass}>
              <Icon name="ArrowUp" className="size-4 text-muted-foreground" aria-hidden />
              <span className="flex-1">Send now</span>
              <StatusDot status={current.status} label={current.statusLabel} />
            </div>
          </Group>
        ) : null}
        <Group label={current && !query ? "Another thread" : "Threads"}>
          {matches.length === 0 ? (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">
              {query ? "No threads match." : "No other threads yet."}
            </p>
          ) : (
            matches.map((thread) => {
              index++;
              return (
                <div
                  key={thread.id}
                  data-kit-handoff-row={thread.id}
                  {...optionProps(options[index]!, index)}
                  className={rowClass}
                >
                  <StatusDot status={thread.status} label={thread.statusLabel} />
                  <span className="min-w-0 flex-1 truncate">{thread.title}</span>
                  {thread.projectName && thread.projectId !== handoff.projectId ? (
                    <span className="max-w-[40%] shrink-0 truncate text-xs text-muted-foreground">
                      {thread.projectName}
                    </span>
                  ) : null}
                </div>
              );
            })
          )}
        </Group>
        <div className="mx-1.5 my-1 border-t border-border/60" />
        <div {...optionProps(options[++index]!, index)} className={rowClass}>
          <Icon name="Plus" className="size-4 text-muted-foreground" aria-hidden />
          <span className="flex-1">New thread</span>
          <ShortcutHint combo="mod+Enter" />
        </div>
      </div>
      <div className="border-t border-border/60 px-3 py-2">
        <button
          type="button"
          onClick={() => setPreview((p) => !p)}
          aria-expanded={preview}
          className="flex h-7 w-full cursor-pointer items-center gap-1.5 rounded-md text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Icon
            name="ChevronRight"
            className={cn("size-3.5 transition-transform duration-200 ease-out", preview && "rotate-90")}
            aria-hidden
          />
          <span className="flex-1 text-left">Preview prompt</span>
          <ShortcutHint combo="Tab" />
        </button>
        <Collapse open={preview}>
          <pre className="mt-1.5 max-h-48 overflow-auto rounded-lg bg-muted/60 p-2.5 font-mono text-xs leading-5 whitespace-pre-wrap text-foreground">
            {prompt}
          </pre>
        </Collapse>
      </div>
    </div>
  );
}

function Group({ label, detail, children }: { label: string; detail?: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label} className="pb-1">
      <p className="flex items-baseline gap-1.5 px-2 pt-1.5 pb-1 text-xs text-muted-foreground">
        <span className="shrink-0">{label}</span>
        {detail ? <span className="min-w-0 truncate text-foreground/80">{detail}</span> : null}
      </p>
      {children}
    </div>
  );
}

function NewThreadDialog<T>({ handoff }: { handoff: Handoff<T> }) {
  return (
    <Dialog open={handoff.newThreadOpen} onOpenChange={handoff.setNewThreadOpen}>
      <DialogContent data-kit-handoff-dialog="" className="gap-3 rounded-xl p-4 sm:max-w-2xl sm:rounded-xl">
        <DialogHeader className="pr-8">
          <DialogTitle className="text-sm font-medium">Send {handoff.label} to a new thread</DialogTitle>
          <DialogDescription className="text-xs">
            Edit the prompt, pick where it runs, then start the thread.
          </DialogDescription>
        </DialogHeader>
        <div className="h-[min(26rem,60vh)] min-h-0">
          {handoff.newThreadOpen ? <ComposerBody handoff={handoff} /> : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Mounted once per opening. The host composer re-seeds whenever its seed
 * props change, so every prop here is fixed for the life of the dialog.
 */
function ComposerBody<T>({ handoff }: { handoff: Handoff<T> }) {
  const latest = useRef(handoff);
  latest.current = handoff;
  const [seed] = useState(() => ({
    prompt: handoff.buildPrompt({ kind: "new" }),
    projectId: handoff.projectId ?? undefined,
    draftKey: handoff.draftKey,
  }));
  const onSubmit = useCallback((request: NewThreadRequest) => latest.current.submitNewThread(request), []);
  return (
    <NewThreadComposer
      draftKey={seed.draftKey}
      initialPrompt={seed.prompt}
      defaultProjectId={seed.projectId}
      focusRequest={1}
      layout="contained"
      onSubmit={onSubmit}
    />
  );
}
