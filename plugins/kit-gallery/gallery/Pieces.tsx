import { useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Collapse,
  EmptyState,
  InlineComposer,
  Kbd,
  LABEL_HUES,
  ProgressLine,
  Segmented,
  ShortcutHint,
  Skeleton,
  SkeletonRows,
  StatusDot,
  TINT_HUES,
  ThreadChip,
  Tint,
  useContainerWidth,
  useHotkeys,
  useKitMotion,
  useLiveThread,
  type RunStatus,
} from "../kit";
import { categoryHue, severityHue } from "./fixtures";

export function Section({ id, title, description, children }: { id: string; title: string; description?: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="flex flex-col gap-3 border-t border-border/70 py-6 first:border-t-0 first:pt-2">
      <div className="flex flex-col gap-0.5">
        <h2 id={`${id}-title`} className="text-sm font-medium">
          {title}
        </h2>
        {description ? <p className="max-w-[72ch] text-xs text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

function Label({ children }: { children: ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}

export function TypeRoles() {
  return (
    <div className="flex max-w-[72ch] flex-col gap-3">
      <p className="text-xl font-semibold tracking-tight">Session expires mid-upload</p>
      <p className="text-sm font-medium">Section and card title</p>
      <p className="text-sm leading-6">
        Body text sits at 13 px with a 24 px line. Prose is capped at 72 characters so a description reads as a document rather than a
        form field, in the side panel and on a wide page alike.
      </p>
      <p className="text-xs text-muted-foreground">
        Meta text: updated <span className="tabular-nums">2h</span> ago by Ana Ruiz
      </p>
      <p className="font-mono text-xs">src/auth/session.ts:42</p>
      <p className="text-xs text-muted-foreground">
        Keys use the UI font with tabular figures: <span className="font-medium text-foreground tabular-nums">ENG-412 ENG-398 ENG-1007</span>
      </p>
    </div>
  );
}

export function MotionTokens() {
  const { transition, variants, reduced } = useKitMotion();
  const [order, setOrder] = useState(["Fix flaky login", "Editor comments", "Jira sync", "Board drag"]);
  const [shown, setShown] = useState(true);
  const [lifted, setLifted] = useState(false);
  const shuffle = () => setOrder((o) => [...o.slice(1), o[0]!]);

  return (
    <div className="flex flex-col gap-4">
      <table className="w-full max-w-xl text-xs">
        <tbody className="[&_td]:py-1 [&_td]:pr-4">
          {[
            ["press", "120 ms, ease-out", "hover, press, focus"],
            ["enter", "200 ms, cubic-bezier(0.22, 1, 0.36, 1)", "things appearing"],
            ["exit", "140 ms, ease-in", "things leaving"],
            ["shift", "spring 520 / 38 / 0.9", "layout, reorder, panels"],
            ["lift", "spring 380 / 26 / 0.8", "drag pick-up and drop"],
            ["handoff", "spring 260 / 30, about 520 ms", "the signature only"],
          ].map(([name, value, use]) => (
            <tr key={name} className="border-b border-border/50 last:border-0">
              <td className="font-medium">{name}</td>
              <td className="tabular-nums text-muted-foreground">{value}</td>
              <td className="text-muted-foreground">{use}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-muted-foreground">
        Reduced motion is {reduced ? "on: travel and scale are off, fades take 120 ms" : "off"}.
      </p>
      <div className="grid gap-4 @[40rem]:grid-cols-3">
        <div className="flex flex-col gap-2">
          <Label>enter and exit</Label>
          <Button variant="outline" size="sm" className="self-start" onClick={() => setShown((s) => !s)}>
            {shown ? "Hide toolbar" : "Show toolbar"}
          </Button>
          <div className="h-10">
            <AnimatePresence>
              {shown ? (
                <motion.div
                  variants={variants.fadeScale}
                  initial="hidden"
                  animate="visible"
                  exit="exit"
                  className="inline-flex h-8 items-center gap-1 rounded-md border border-border bg-popover px-1 shadow-lg"
                >
                  <Button variant="ghost" size="sm" className="h-6 px-2">
                    Comment <Kbd>C</Kbd>
                  </Button>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <Label>shift</Label>
          <Button variant="outline" size="sm" className="self-start" onClick={shuffle}>
            Reorder
          </Button>
          <ul className="flex flex-col gap-1">
            {order.map((item) => (
              <motion.li key={item} layout transition={transition("shift")} className="flex h-8 items-center rounded-lg border border-border bg-card px-2.5 text-sm">
                {item}
              </motion.li>
            ))}
          </ul>
        </div>
        <div className="flex flex-col gap-2">
          <Label>lift</Label>
          <Button variant="outline" size="sm" className="self-start" onClick={() => setLifted((l) => !l)}>
            {lifted ? "Drop" : "Pick up"}
          </Button>
          <motion.div
            animate={reduced ? { opacity: lifted ? 0.9 : 1 } : { scale: lifted ? 1.03 : 1, y: lifted ? -4 : 0, rotate: lifted ? -1 : 0 }}
            transition={transition("lift")}
            className={cn(
              "flex h-16 items-center rounded-lg border border-border bg-card px-3 text-sm transition-shadow duration-200",
              lifted && "shadow-lg",
            )}
          >
            Fix flaky login
          </motion.div>
        </div>
      </div>
    </div>
  );
}

export function Keys() {
  const [view, setView] = useState<"edit" | "diff">("edit");
  const [mode, setMode] = useState<"unified" | "split">("unified");
  const [density, setDensity] = useState<"board" | "list">("board");
  const [last, setLast] = useState<string | null>(null);
  useHotkeys([
    { key: "e", handler: () => setView("edit"), description: "Edit view", group: "Gallery" },
    { key: "d", handler: () => setView("diff"), description: "Diff view", group: "Gallery" },
    { key: "/", handler: () => setLast("/ focuses search"), description: "Search", group: "Gallery" },
    { key: "mod+k", handler: () => setLast("mod+k pressed"), description: "Command example", group: "Gallery" },
  ]);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented aria-label="View" value={view} onChange={setView} options={[{ value: "edit", label: "Edit", title: "Edit (E)" }, { value: "diff", label: "Diff", title: "Diff (D)" }]} />
        <Segmented aria-label="Diff layout" value={mode} onChange={setMode} options={[{ value: "unified", label: "Unified" }, { value: "split", label: "Split" }]} />
        <Segmented
          aria-label="Board or list"
          size="md"
          value={density}
          onChange={setDensity}
          options={[{ value: "board", label: "Board" }, { value: "list", label: "List" }, { value: "x" as "list", label: "Disabled", disabled: true }]}
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <ShortcutHint combo="s" label="Send to thread" />
        <ShortcutHint combo="mod+Enter" label="to send" />
        <ShortcutHint combo="shift+n" />
        <ShortcutHint combo="Escape" label="to close" />
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <Kbd>j</Kbd>
          <Kbd>k</Kbd> to move
        </span>
        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          Press <Kbd>?</Kbd> for the shortcut sheet
        </span>
      </div>
      <p className="text-xs text-muted-foreground" aria-live="polite">
        Try E and D to switch the first control. {last ?? ""}
      </p>
    </div>
  );
}

export function Status({ liveThreadId }: { liveThreadId: string | null }) {
  const live = useLiveThread(liveThreadId);
  const states: RunStatus[] = ["idle", "running", "waiting", "failed"];
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        {states.map((s) => (
          <span key={s} className="inline-flex items-center gap-2 text-sm">
            <StatusDot status={s} />
            {s === "waiting" ? "Needs you" : s[0]!.toUpperCase() + s.slice(1)}
          </span>
        ))}
        <span className="inline-flex items-center gap-2 text-sm">
          <StatusDot status="running" size="md" /> md
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <ThreadChip threadId="thr_demo_1" title="Fix session refresh race" status="running" onOpen={() => undefined} />
        <ThreadChip threadId="thr_demo_2" title="Jira sync: paginate search results" status="waiting" onOpen={() => undefined} />
        <ThreadChip threadId="thr_demo_4" title="Flaky login test on CI" status="failed" onOpen={() => undefined} />
        <ThreadChip threadId="thr_demo_3" title="A long thread title that has to truncate inside a narrow side panel" status="idle" prefix="Sent to" className="max-w-64" onOpen={() => undefined} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label>Live: a real thread from bb's sidebar view, opens it on click</Label>
        {live ? <ThreadChip threadId={live.id} className="self-start" /> : <p className="text-xs text-muted-foreground">No live thread found.</p>}
      </div>
    </div>
  );
}

export function Tints() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-1.5">
        {TINT_HUES.map((h) => (
          <Tint key={h} hue={h}>
            {h}
          </Tint>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {LABEL_HUES.map((h) => (
          <Tint key={h} hue={h} dot>
            label {h}
          </Tint>
        ))}
      </div>
      <div className="grid gap-3 @[36rem]:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label>Comment severity</Label>
          <div className="flex gap-1.5">
            <Tint hue={severityHue.issue}>Issue</Tint>
            <Tint hue={severityHue.question}>Question</Tint>
            <Tint hue={severityHue.nit}>Nit</Tint>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>Jira status category</Label>
          <div className="flex gap-1.5">
            <Tint hue={categoryHue.new}>To do</Tint>
            <Tint hue={categoryHue.indeterminate}>In progress</Tint>
            <Tint hue={categoryHue.done}>Done</Tint>
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label>On each surface step</Label>
        <div className="grid gap-2 @[36rem]:grid-cols-3">
          {(["bg-background", "bg-card", "bg-muted"] as const).map((bg) => (
            <div key={bg} className={cn("flex flex-wrap gap-1.5 rounded-lg border border-border p-2", bg)}>
              <Tint hue="amber">amber</Tint>
              <Tint hue="red">red</Tint>
              <Tint hue="blue">blue</Tint>
              <Tint hue="green">green</Tint>
              <Tint hue="yellow">yellow</Tint>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function LoadingAndEmpty() {
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(true);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState(false);
  const [added, setAdded] = useState<string[]>([]);
  const [composing, setComposing] = useState(false);
  const { ref, width } = useContainerWidth<HTMLDivElement>();

  const reload = () => {
    setLoading(true);
    setTimeout(() => setLoading(false), 1600);
  };

  return (
    <div ref={ref} className="flex flex-col gap-5">
      <p className="text-xs text-muted-foreground tabular-nums">useContainerWidth: {Math.round(width)} px</p>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setRefreshing((r) => !r)}>
            {refreshing ? "Stop refresh" : "Start refresh"}
          </Button>
          <Button variant="outline" size="sm" onClick={reload}>
            Load list
          </Button>
        </div>
        <div className="overflow-hidden rounded-lg border border-border">
          <div className="relative flex h-10 items-center border-b border-border px-3 text-sm font-medium">
            In progress <span className="ml-1.5 text-muted-foreground tabular-nums">3</span>
            <ProgressLine active={refreshing} />
          </div>
          {loading ? (
            <SkeletonRows count={3} className="py-1" />
          ) : (
            <ul className="py-1">
              {["ENG-412 Session expires mid-upload", "ENG-398 Retry queue drops jobs", "ENG-420 Export fails over 10k rows"].map((r) => (
                <li key={r} className="flex h-8 items-center px-3 text-sm">
                  {r}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex items-center gap-3">
          <Skeleton className="h-6 w-6 rounded-full" />
          <Skeleton className="h-3 w-32" />
        </div>
      </div>
      <div className="flex flex-col gap-2" data-skeleton-probe="">
        <Label>Skeletons in flex, grid and block parents (always shown)</Label>
        <div className="rounded-lg border border-border">
          <SkeletonRows count={3} className="py-1" />
        </div>
        <div className="flex items-center gap-3" data-parent="flex">
          <Skeleton className="w-1/2" />
          <Skeleton className="w-16" />
        </div>
        <div className="grid grid-cols-[auto_1fr] items-center gap-3" data-parent="grid">
          <Skeleton className="size-6 rounded-full" />
          <Skeleton className="w-3/4" />
        </div>
        <div data-parent="block">
          <Skeleton className="w-2/3" />
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <Button variant="outline" size="sm" className="self-start" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? "Collapse" : "Expand"} details
        </Button>
        <Collapse open={open}>
          <div className="rounded-lg border border-border bg-card p-3 text-sm leading-6">
            Collapse animates grid rows, not height, and makes closed content inert so it cannot take focus.
          </div>
        </Collapse>
      </div>
      <div className="grid gap-3 @[40rem]:grid-cols-2">
        <div className="rounded-lg border border-border">
          <EmptyState
            icon="MessageSquare"
            title="No comments yet"
            description={
              <>
                Select lines in the editor and press <Kbd>C</Kbd> to comment.
              </>
            }
            action={<Button size="sm">Comment</Button>}
          />
        </div>
        <div className="rounded-lg border border-border">
          {error ? (
            <EmptyState
              tone="error"
              icon="AlertCircle"
              title="Jira rejected the API token"
              description="The token for ana@example.com expired. Create a new token in Atlassian account settings and paste it in Settings."
              action={
                <Button size="sm" variant="outline" onClick={() => setError(false)}>
                  Open settings
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon="Filter"
              title="No issues in this view"
              description="Saved views list issues by JQL. Edit the query to widen it."
              action={
                <Button size="sm" variant="outline" onClick={() => setError(true)}>
                  Show error state
                </Button>
              }
            />
          )}
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <Label>Inline composer (keeps open after Enter)</Label>
        {composing ? (
          <InlineComposer
            placeholder="Task title"
            submitLabel="Add task"
            keepOpen
            onSubmit={async (v) => {
              await new Promise((r) => setTimeout(r, 200));
              if (v.toLowerCase().includes("fail")) throw new Error("A task with this title already exists in To do.");
              setAdded((a) => [v, ...a]);
            }}
            onCancel={() => setComposing(false)}
          />
        ) : (
          <Button variant="ghost" size="sm" className="self-start" onClick={() => setComposing(true)}>
            New task <Kbd>N</Kbd>
          </Button>
        )}
        <ul className="flex flex-col">
          <AnimatePresence initial={false}>
            {added.map((a) => (
              <motion.li key={a} layout initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className="flex h-8 items-center text-sm">
                {a}
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      </div>
    </div>
  );
}
