// Ask (`i`): a small box on the row, naming what is asked about, with a field
// and a few ready questions that fit it. Enter sends the question to the
// thread now; Escape drops it. Drawn inside the tree, under the row.
import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Kbd } from "../../kit";
import { readyQuestions } from "./agent";
import { EntryIcon } from "./icons";
import { nameOf } from "./model";

export interface AskTarget {
  path: string;
  kind: "file" | "dir";
}

export function AskBox({
  targets,
  top,
  thread,
  onSend,
  onClose,
}: {
  targets: readonly AskTarget[];
  top: number;
  thread: string;
  onSend(text: string): Promise<boolean>;
  onClose(): void;
}) {
  const field = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [place, setPlace] = useState(top);
  const one = targets.length === 1 ? targets[0]! : null;
  const label = one ? nameOf(one.path) : `${targets.length} entries`;
  const questions = readyQuestions(targets.map((t) => t.kind));

  useLayoutEffect(() => {
    field.current?.focus({ preventScroll: true });
    // Above the row when it would leave the tree at the bottom.
    const el = root.current;
    const box = el?.offsetParent as HTMLElement | null;
    if (el && box && top + el.offsetHeight > box.clientHeight - 4) setPlace(Math.max(4, top - el.offsetHeight - 30));
  }, [top]);

  const send = async (value: string) => {
    if (!value.trim() || sending) return;
    setSending(true);
    const sent = await onSend(value.trim());
    setSending(false);
    if (!sent) field.current?.focus();
  };

  return (
    <div
      ref={root}
      role="dialog"
      aria-label={`Ask about ${label}`}
      data-files-ask
      style={{ top: place }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null) && !sending) onClose();
      }}
      className="absolute inset-x-2 z-20 flex flex-col gap-2 rounded-xl border border-border bg-popover p-2.5 text-popover-foreground shadow-lg motion-safe:animate-[helix-files-arrive_200ms_cubic-bezier(0.22,1,0.36,1)]"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        {targets.slice(0, 4).map((t) => (
          <span key={t.path} title={t.path} className="inline-flex h-6 max-w-full items-center gap-1 rounded-md bg-muted px-1.5 text-xs">
            <EntryIcon dir={t.kind === "dir"} name={nameOf(t.path)} className="size-3.5" />
            <span className="truncate">{nameOf(t.path)}</span>
          </span>
        ))}
        {targets.length > 4 ? <span className="text-xs text-muted-foreground">and {targets.length - 4} more</span> : null}
      </div>
      <input
        ref={field}
        value={text}
        disabled={sending}
        placeholder={`Ask about ${label}`}
        aria-label={`Ask about ${label}`}
        spellCheck
        data-files-ask-field
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void send(text);
          }
        }}
        className="h-8 rounded-md border border-border/80 bg-background px-2 text-[13px] outline-none placeholder:text-muted-foreground focus:border-ring/70"
      />
      <div className="flex flex-wrap gap-1" role="group" aria-label="Ready questions">
        {questions.map((q) => (
          <button
            key={q}
            type="button"
            data-files-ask-chip
            onClick={() => {
              setText(q);
              field.current?.focus();
            }}
            className={cn("h-6 rounded-full border border-border/80 px-2 text-xs text-muted-foreground transition-colors duration-[120ms] hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", text === q && "border-ring/60 text-foreground")}
          >
            {q}
          </button>
        ))}
      </div>
      <p className="flex items-center gap-1 text-xs text-muted-foreground">
        <Kbd>↵</Kbd> sends it to <span className="min-w-0 truncate text-foreground">{thread}</span>
        <span className="flex-1" />
        <Kbd>Esc</Kbd>
      </p>
    </div>
  );
}
