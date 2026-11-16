import { useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import {
  HandoffSheet,
  SentChip,
  Segmented,
  StatusDot,
  ThreadChip,
  Tint,
  hueFor,
  useHandoff,
  useHotkeys,
  useKitMotion,
  type HandoffResult,
  type HandoffTarget,
  type HandoffTransport,
  type JsonObject,
} from "../kit";
import {
  CURRENT_THREAD_ID,
  categoryHue,
  comments,
  fakeThreads,
  issuePrompt,
  issues,
  metadataFor,
  reviewPrompt,
  severityHue,
  taskPrompt,
  tasks,
  type Issue,
  type ReviewComment,
  type Task,
} from "./fixtures";

type Shape = "review" | "task" | "issue";

interface Log {
  at: number;
  text: string;
}

/**
 * The handoff with fake items from all three plugins, fake threads and fake
 * destinations, so every target can be exercised without touching real
 * threads. "Real threads" switches to bb's live thread list and SDK.
 */
export function HandoffDemo({ currentThreadId, projectId }: { currentThreadId: string | null; projectId: string | null }) {
  const [shape, setShape] = useState<Shape>("review");
  const [real, setReal] = useState(false);
  const [failNext, setFailNext] = useState(false);
  const [draft, setDraft] = useState("");
  const [log, setLog] = useState<Log[]>([]);
  const failRef = useRef(failNext);
  failRef.current = failNext;

  const note = (text: string) => setLog((l) => [{ at: Date.now(), text }, ...l].slice(0, 4));

  const transport = useMemo<HandoffTransport>(() => {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const maybeFail = () => {
      if (failRef.current) {
        setFailNext(false);
        throw new Error("the thread was archived. Unarchive it or pick another thread");
      }
    };
    return {
      insert: async (threadId, prompt, metadata) => {
        await wait(120);
        maybeFail();
        setDraft(prompt);
        note(`insert into ${threadId}, metadata ${JSON.stringify(metadata)}`);
      },
      send: async (threadId, _prompt, metadata) => {
        await wait(320);
        maybeFail();
        note(`send to ${threadId}, metadata ${JSON.stringify(metadata)}`);
        return threadId === "thr_demo_1" || threadId === "thr_demo_6" ? "queued" : "sent";
      },
      spawn: async (request, metadata, title) => {
        await wait(400);
        maybeFail();
        note(`spawn in ${request.projectId}, title ${title ?? "none"}, metadata ${JSON.stringify(metadata)}`);
        return { id: "thr_demo_new", title: title ?? "New thread" };
      },
    };
  }, []);

  const common = {
    currentThreadId: real ? currentThreadId : CURRENT_THREAD_ID,
    // The new-thread composer needs a real project id even in the fake demo.
    projectId,
    transport: real ? undefined : transport,
    threads: real ? undefined : fakeThreads.map((t) => (t.projectId === "p1" ? { ...t, projectId: projectId ?? "p1" } : t)),
    hotkey: "s",
  };

  return (
    <div className="@container flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Segmented
          aria-label="Item shape"
          value={shape}
          onChange={setShape}
          options={[
            { value: "review", label: "Comments" },
            { value: "task", label: "Tasks" },
            { value: "issue", label: "Issues" },
          ]}
        />
        <Toggle checked={failNext} onChange={setFailNext}>
          Fail next send
        </Toggle>
        <Toggle checked={real} onChange={setReal}>
          Real threads (sends real messages)
        </Toggle>
      </div>
      <div className="grid gap-3 @[44rem]:grid-cols-[minmax(0,1fr)_15rem]">
        {shape === "review" ? (
          <Source
            key="review"
            items={comments}
            getKey={(c) => c.id}
            noun={{ one: "comment", many: "comments" }}
            buildPrompt={reviewPrompt}
            metadata={metadataFor.review}
            render={(c) => <CommentRow comment={c} />}
            {...common}
          />
        ) : shape === "task" ? (
          <Source
            key="task"
            items={tasks}
            getKey={(t) => t.id}
            noun={{ one: "task", many: "tasks" }}
            buildPrompt={taskPrompt}
            metadata={metadataFor.task}
            newThreadTitle={(ts) => ts[0]?.title}
            buttonLabel="Start work"
            render={(t) => <TaskRow task={t} />}
            {...common}
          />
        ) : (
          <Source
            key="issue"
            items={issues}
            getKey={(i) => i.key}
            noun={{ one: "issue", many: "issues" }}
            buildPrompt={issuePrompt}
            metadata={metadataFor.issue}
            newThreadTitle={(is) => (is.length === 1 ? `${is[0]!.key} ${is[0]!.summary}` : undefined)}
            render={(i) => <IssueRow issue={i} />}
            {...common}
          />
        )}
        {real ? null : <FakeDestinations draft={draft} onClear={() => setDraft("")} />}
      </div>
      {log.length > 0 ? (
        <ul className="flex flex-col gap-0.5 font-mono text-xs text-muted-foreground" aria-label="Transport log">
          {log.map((l) => (
            <li key={l.at} className="truncate">
              {l.text}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Source<T>({
  items,
  getKey,
  noun,
  buildPrompt,
  metadata,
  render,
  newThreadTitle,
  buttonLabel,
  currentThreadId,
  projectId,
  transport,
  threads,
  hotkey,
}: {
  items: readonly T[];
  getKey: (item: T) => string;
  noun: { one: string; many: string };
  buildPrompt: (items: readonly T[], target: HandoffTarget) => string;
  metadata: (items: readonly T[]) => JsonObject;
  render: (item: T) => ReactNode;
  newThreadTitle?: (items: readonly T[]) => string | undefined;
  buttonLabel?: string;
  currentThreadId: string | null;
  projectId: string | null;
  transport: HandoffTransport | undefined;
  threads: typeof fakeThreads | undefined;
  hotkey: string;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set([getKey(items[0]!)]));
  const [focus, setFocus] = useState(0);
  const [sentTo, setSentTo] = useState<Record<string, HandoffResult>>({});
  const list = useRef<HTMLUListElement>(null);
  const { variants } = useKitMotion();

  const selection = useMemo(() => items.filter((i) => selected.has(getKey(i))), [items, selected, getKey]);
  const handoff = useHandoff({
    items: selection,
    getKey,
    buildPrompt,
    pluginMetadata: (xs) => metadata(xs),
    noun,
    currentThreadId,
    projectId,
    newThreadTitle,
    hotkey,
    transport,
    threads,
    onSent: (result) => {
      setSentTo((prev) => {
        const next = { ...prev };
        for (const key of result.itemKeys) next[key] = result;
        return next;
      });
    },
  });

  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const moveFocus = (delta: number) => {
    const next = Math.max(0, Math.min(items.length - 1, focus + delta));
    setFocus(next);
    list.current?.querySelectorAll<HTMLElement>("[data-row]")[next]?.focus();
  };

  useHotkeys(
    [
      { key: ["j", "ArrowDown"], handler: () => moveFocus(1), description: "Next item", group: "Handoff demo" },
      { key: ["k", "ArrowUp"], handler: () => moveFocus(-1), description: "Previous item", group: "Handoff demo" },
      { key: "x", handler: () => toggle(getKey(items[focus]!)), description: "Select item", group: "Handoff demo" },
      { key: "Escape", handler: () => setSelected(new Set()), description: "Clear selection", group: "Handoff demo", enabled: selected.size > 0 },
    ],
    { scope: list },
  );

  return (
    <div className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card">
      <ul ref={list} className="flex flex-col p-1" aria-label="Items">
        {items.map((item, index) => {
          const key = getKey(item);
          const isSelected = selected.has(key);
          const result = sentTo[key];
          return (
            <li key={key}>
              <div
                ref={handoff.itemRef(key)}
                data-row
                tabIndex={index === focus ? 0 : -1}
                onFocus={() => setFocus(index)}
                onClick={() => toggle(key)}
                onKeyDown={(e) => {
                  if (e.key === " ") {
                    e.preventDefault();
                    toggle(key);
                  }
                }}
                aria-selected={isSelected}
                className={cn(
                  "flex cursor-pointer gap-3 rounded-md px-2.5 py-2 outline-none transition-colors duration-[120ms] ease-out",
                  "focus-visible:ring-2 focus-visible:ring-ring",
                  isSelected ? "bg-surface-selected" : "hover:bg-state-hover",
                )}
              >
                <Checkbox
                  checked={isSelected}
                  tabIndex={-1}
                  aria-label={`Select ${key}`}
                  onClick={(e) => e.stopPropagation()}
                  onCheckedChange={() => toggle(key)}
                  className="mt-0.5"
                />
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  {render(item)}
                  <AnimatePresence initial={false}>
                    {result ? (
                      <motion.div key={result.at} variants={variants.fadeScale} initial="hidden" animate="visible" exit="exit">
                        <ThreadChip
                          threadId={result.threadId}
                          title={result.threadTitle}
                          prefix={result.delivery === "inserted" ? "Drafted in" : "Sent to"}
                          onOpen={() => undefined}
                        />
                      </motion.div>
                    ) : null}
                  </AnimatePresence>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      <div className="@container mt-auto border-t border-border/70 px-3 py-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <span className="text-xs text-muted-foreground tabular-nums">
            {selection.length === 0 ? "Nothing selected" : `${handoff.label} selected`}
          </span>
          <span className="order-last flex min-w-0 basis-full @[30rem]:order-none @[30rem]:flex-1 @[30rem]:basis-auto">
            <SentChip result={handoff.lastResult} />
          </span>
          <span className="flex-1 @[30rem]:hidden" />
          <HandoffSheet handoff={handoff} buttonLabel={buttonLabel} />
        </div>
      </div>
    </div>
  );
}

function CommentRow({ comment }: { comment: ReviewComment }) {
  return (
    <>
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
          {comment.path}:{comment.start === comment.end ? comment.start : `${comment.start}-${comment.end}`}
        </span>
        <Tint hue={severityHue[comment.severity]}>{comment.severity === "nit" ? "Nit" : comment.severity === "issue" ? "Issue" : "Question"}</Tint>
      </div>
      <p className="text-sm leading-6 text-foreground">{comment.body}</p>
    </>
  );
}

function TaskRow({ task }: { task: Task }) {
  return (
    <>
      <p className="text-sm font-medium">{task.title}</p>
      <div className="flex flex-wrap items-center gap-1.5">
        {task.labels.map((l) => (
          <Tint key={l} hue={hueFor(l)} dot>
            {l}
          </Tint>
        ))}
        <span className="text-xs text-muted-foreground">{task.lane}</span>
      </div>
    </>
  );
}

function IssueRow({ issue }: { issue: Issue }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
      <span className="text-sm font-medium tabular-nums">{issue.key}</span>
      <span className="min-w-0 flex-1 truncate text-sm">{issue.summary}</span>
      <Tint hue={categoryHue[issue.category]}>{issue.status}</Tint>
    </div>
  );
}

/** Stand-ins for bb's own targets, carrying the same DOM markers the kit looks for. */
function FakeDestinations({ draft, onClear }: { draft: string; onClear: () => void }) {
  return (
    <aside aria-label="Fake destinations" className="flex min-w-0 flex-col gap-2 rounded-lg border border-dashed border-border p-2">
      <p className="px-1 text-xs text-muted-foreground">Fake thread list</p>
      <ul className="flex flex-col">
        {fakeThreads.slice(1, 5).map((t) => (
          <li key={t.id} data-sidebar-thread-id={t.id} className="flex h-7 items-center gap-2 rounded-md px-1.5 text-xs">
            <StatusDot status={t.status} />
            <span className="truncate">{t.title}</span>
          </li>
        ))}
      </ul>
      <p className="px-1 pt-1 text-xs text-muted-foreground">Composer of this thread</p>
      <div data-promptbox-layout="" className="min-h-16 rounded-lg border border-border bg-background p-2 text-xs">
        {draft ? (
          <>
            <p className="whitespace-pre-wrap text-foreground">{draft}</p>
            <button type="button" onClick={onClear} className="mt-1 cursor-pointer text-muted-foreground underline-offset-2 hover:underline">
              Clear
            </button>
          </>
        ) : (
          <p className="text-muted-foreground">Ask for a follow-up</p>
        )}
      </div>
    </aside>
  );
}

function Toggle({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
      <Checkbox checked={checked} onCheckedChange={(v) => onChange(v === true)} />
      {children}
    </label>
  );
}
