// How a comment reads in the rail: under its file's header, a card with its
// state and severity as tinted chips, the lines it quotes as code (numbered
// from their place in the file, in the host's code theme), the comment and
// the replies under it. Pure presentation: CommentsTab owns the data, the
// cursor and the keys.
import { useEffect, useMemo, useRef, useState } from "react";
import { experimental_useCodeTheme as useCodeTheme, Markdown } from "@get-bb/plugin-sdk/app";
import type { RailComment } from "../../server";
import { cn } from "@/lib/utils";
import { ShortcutHint, TINT_CLASSES, TINT_DOT_CLASSES, type TintHue } from "../../kit";
import { Glyph, type GlyphName } from "./glyphs";
import { highlightLines, languageOf, styleOf } from "./highlight";

/** What a state means for the owner, and the hue it is scanned by. */
export const STATE: Record<RailComment["state"], { label: string; hint: string; hue: TintHue }> = {
  unsent: { label: "Not sent", hint: "Waiting here until you send it to the thread", hue: "amber" },
  sent: { label: "Sent", hint: "Sent to the thread; the agent has not answered", hue: "blue" },
  answered: { label: "Answered", hint: "The agent answered and left it open", hue: "violet" },
  resolved: { label: "Resolved", hint: "Resolved by the agent: A accepts it, O reopens it", hue: "emerald" },
  outdated: { label: "Outdated", hint: "The lines it was written on have changed", hue: "gray" },
  done: { label: "Done", hint: "Resolved and accepted", hue: "gray" },
};

const SEVERITY: Record<string, { label: string; hue: TintHue; glyph: GlyphName }> = {
  suggestion: { label: "Suggestion", hue: "teal", glyph: "suggestion" },
  issue: { label: "Issue", hue: "orange", glyph: "issue" },
  blocker: { label: "Blocker", hue: "red", glyph: "blocker" },
};

function Chip({ hue, glyph, title, children }: { hue: TintHue; glyph: GlyphName; title?: string; children: React.ReactNode }) {
  return (
    <span title={title} className={cn("inline-flex h-5 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium whitespace-nowrap", TINT_CLASSES[hue])}>
      <Glyph name={glyph} className="size-3 shrink-0" />
      {children}
    </span>
  );
}

/** The file a group of comments is on: its name first, where it lives after, how many comments it has. */
export function FileHeader({ path, count }: { path: string; count: number }) {
  const slash = path.lastIndexOf("/");
  const name = path.slice(slash + 1);
  const dir = slash > 0 ? path.slice(0, slash) : "";
  return (
    <div className="sticky top-0 z-10 bg-background pb-1.5 pt-2" title={path} data-helix-comment-file={path}>
      <div className="flex items-center gap-1.5 rounded-md bg-muted px-2 py-1">
        <Glyph name="file" className="size-3.5 shrink-0 text-foreground" />
        <span className="max-w-[65%] shrink-0 truncate font-mono text-xs font-semibold text-foreground">{name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">{dir}</span>
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground" aria-label={`${count} ${count === 1 ? "comment" : "comments"}`}>
          {count}
        </span>
      </div>
    </div>
  );
}

/** The most lines of a quote the rail shows; the rest is counted under it. */
const QUOTE_LINES = 8;

/** The snippet without the indentation all its lines share, and without blank lines at its end. */
export function dedent(snippet: string): string {
  const lines = snippet.replace(/\s+$/u, "").split("\n");
  const indents = lines.filter((line) => line.trim() !== "").map((line) => line.length - line.trimStart().length);
  const shared = indents.length > 0 ? Math.min(...indents) : 0;
  return lines.map((line) => line.slice(Math.min(shared, line.length - line.trimStart().length))).join("\n");
}

/**
 * The quoted lines as code: highlighted for the file's language, each line
 * numbered as in the file, on the host code theme's own background so its
 * colours keep the contrast they were chosen for.
 */
export function CodeQuote({ path, startLine, snippet, onOpen }: { path: string; startLine: number; snippet: string; onOpen?(): void }) {
  const { theme } = useCodeTheme();
  const lines = useMemo(() => highlightLines(dedent(snippet), languageOf(path)), [snippet, path]);
  const shown = lines.slice(0, QUOTE_LINES);
  const more = lines.length - shown.length;
  const numberColour = theme?.colors["editorLineNumber.foreground"];
  return (
    <div
      role={onOpen ? "button" : undefined}
      onClick={onOpen}
      title={onOpen ? "Show these lines in Helix (Enter)" : undefined}
      className={cn("overflow-hidden rounded-md border border-border/70 py-1 font-mono text-[11px] leading-[18px] [tab-size:2]", !theme && "bg-muted text-foreground", onOpen && "cursor-pointer hover:border-foreground/30")}
      style={theme ? { background: theme.bg, color: theme.fg } : undefined}
      data-helix-code-quote
    >
      {shown.map((tokens, i) => (
        <div key={i} className="flex">
          <span aria-hidden className={cn("w-9 shrink-0 select-none pr-2 text-right tabular-nums", !numberColour && "opacity-50")} style={numberColour ? { color: numberColour } : undefined}>
            {startLine + i}
          </span>
          <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-pre pr-2">
            {tokens.length === 0
              ? " "
              : tokens.map((token, j) => {
                  const style = styleOf(theme, token.kind);
                  return style ? (
                    <span key={j} style={style}>
                      {token.text}
                    </span>
                  ) : (
                    token.text
                  );
                })}
          </span>
        </div>
      ))}
      {more > 0 ? (
        <div className="flex opacity-60">
          <span aria-hidden className="w-9 shrink-0 pr-2 text-right">
            …
          </span>
          <span>
            {more} more {more === 1 ? "line" : "lines"}
          </span>
        </div>
      ) : null}
    </div>
  );
}

/** The host's Markdown at the rail's size (it is set for a chat message's width). */
const PROSE = "text-[13px] leading-5 [&_p]:text-[13px] [&_p]:leading-5 [&_li]:text-[13px] [&_li]:leading-5 [&_blockquote]:text-[13px] [&_code]:text-[12px] [&_pre]:text-[12px]";

function lineLabel(c: RailComment): string {
  return c.startLine === c.endLine ? `Line ${c.startLine}` : `Lines ${c.startLine}–${c.endLine}`;
}

export function CommentCard({
  comment: c,
  index,
  selected,
  editing,
  confirmDrop,
  onPick,
  onOpen,
  onEdited,
  onReplied,
}: {
  comment: RailComment;
  index: number;
  selected: boolean;
  /** This card's body is being edited, or a reply to it written. */
  editing: "edit" | "reply" | null;
  confirmDrop: boolean;
  onPick(): void;
  /** Show its lines in Helix. */
  onOpen(): void;
  /** The edit ended: the new text, or null when it was left as it was. */
  onEdited(text: string | null): void;
  onReplied(text: string | null): void;
}) {
  const state = STATE[c.state];
  const severity = SEVERITY[c.severity];
  const quiet = c.state === "done" || c.state === "outdated";
  return (
    <article
      data-index={index}
      data-helix-comment-state={c.state}
      aria-current={selected || undefined}
      onMouseDown={onPick}
      className={cn(
        "relative mb-1.5 flex scroll-mt-10 flex-col gap-2 rounded-lg border py-2 pl-3 pr-2 text-xs transition-colors duration-[120ms]",
        selected ? "border-foreground/30 bg-state-hover" : "border-border/60 bg-card hover:border-border",
      )}
    >
      <span aria-hidden className={cn("absolute inset-y-2 left-1 w-0.5 rounded-full", TINT_DOT_CLASSES[state.hue], quiet && "opacity-40")} />
      <div className="flex items-center gap-1.5">
        <Chip hue={state.hue} glyph={c.state} title={state.hint}>
          {state.label}
        </Chip>
        {severity ? (
          <Chip hue={severity.hue} glyph={severity.glyph}>
            {severity.label}
          </Chip>
        ) : null}
        <button
          type="button"
          onClick={onOpen}
          className="ml-auto shrink-0 rounded font-mono text-[11px] tabular-nums text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          title="Show these lines in Helix (Enter)"
        >
          {lineLabel(c)}
        </button>
      </div>
      {c.snippet.trim() ? <CodeQuote path={c.path} startLine={c.startLine} snippet={c.snippet} onOpen={onOpen} /> : null}
      {editing === "edit" ? (
        <InlineText initial={c.body} label="Save" onDone={onEdited} />
      ) : (
        <Markdown content={c.body} className={cn(PROSE, quiet ? "text-muted-foreground" : "text-foreground")} />
      )}
      {c.replies.length > 0 ? (
        <div className="flex flex-col gap-2 border-l border-border pl-2.5">
          {c.replies.map((r, i) => (
            <div key={i} className="flex flex-col gap-0.5" data-helix-reply={r.author}>
              <span className={cn("flex items-center gap-1 text-[11px] font-medium", r.author === "agent" ? "text-violet-700 in-[.dark]:text-violet-300" : "text-muted-foreground")}>
                <Glyph name={r.author === "agent" ? "agent" : "you"} className="size-3 shrink-0" />
                {r.author === "agent" ? "Agent" : "You"}
              </span>
              <Markdown content={r.body} className={cn(PROSE, "text-foreground")} />
            </div>
          ))}
        </div>
      ) : null}
      {editing === "reply" ? <InlineText initial="" label="Reply" onDone={onReplied} /> : null}
      {selected && editing === null ? <Actions comment={c} confirmDrop={confirmDrop} /> : null}
    </article>
  );
}

function Actions({ comment, confirmDrop }: { comment: RailComment; confirmDrop: boolean }) {
  const items: { combo: string; label: string }[] = [];
  if (comment.state === "unsent" || comment.state === "sent") items.push({ combo: "e", label: "edit" });
  if (!comment.local && comment.state !== "unsent") items.push({ combo: "r", label: "reply" });
  if (comment.state === "resolved") items.push({ combo: "a", label: "got it" });
  if (comment.state === "resolved" || comment.state === "done") items.push({ combo: "o", label: "reopen" });
  items.push({ combo: "d", label: confirmDrop ? "press d again to drop" : "drop" });
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 pt-1.5">
      {items.map((i) => (
        <ShortcutHint key={i.combo} combo={i.combo} label={i.label} className={i.combo === "d" && confirmDrop ? "text-destructive" : undefined} />
      ))}
    </div>
  );
}

/** Edit or reply in place: Enter keeps it, Shift+Enter is a new line, Escape leaves it as it was. */
function InlineText({ initial, label, onDone }: { initial: string; label: string; onDone(text: string | null): void }) {
  const [text, setText] = useState(initial);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  return (
    <textarea
      ref={area}
      value={text}
      aria-label={label}
      rows={Math.min(6, Math.max(2, text.split("\n").length))}
      onChange={(event) => setText(event.target.value)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          onDone(null);
        } else if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          onDone(text.trim() || null);
        }
      }}
      onBlur={() => onDone(null)}
      className="w-full resize-none rounded-md border border-border/60 bg-background px-2 py-1 text-xs leading-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    />
  );
}
