// The tree's rows: a virtual list of fixed-height rows, only those in view
// (and the cursor's) in the document. Each row is memoised on what it shows,
// so moving the cursor re-renders two rows, not the list.
import { memo, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { EntryIcon, FileIcon, FolderIcon, UiGlyph } from "./icons";
import { rowKey, stemLength, type Row } from "./model";

export const ROW = 28;
/** Indentation per level, in px; the guides in tree.css repeat at the same step. */
export const INDENT = 14;
const PAD = 6;
const OVERSCAN = 2;
/**
 * The rows drawn move in blocks of this many. In bb's page, putting any
 * element into the document costs a style pass over the panel (about 8 ms,
 * from a `:has()` rule of bb's), while changing a class or a text costs
 * nothing; so a cursor move only changes classes, and scrolling row by row
 * adds rows once per block, all at once.
 */
const BLOCK = 16;

export type Status = { letter: string; className: string; label: string };

export interface RowPointer {
  down(index: number, event: React.MouseEvent): void;
  click(index: number, event: React.MouseEvent): void;
  open(index: number): void;
}

export interface Editing {
  key: string;
  value: string;
  submit(value: string): void;
  cancel(): void;
  change(value: string): void;
}

export function TreeRows({
  listRef,
  rows,
  cursor,
  focused,
  selected,
  cut,
  status,
  changedDirs,
  editing,
  mark,
  arrived,
  label,
  pointer,
  scroll,
  onKeyDown,
  onFocusChange,
  onScrolled,
  onContextMenu,
  children,
}: {
  listRef: React.RefObject<HTMLDivElement | null>;
  rows: readonly Row[];
  cursor: number;
  focused: boolean;
  selected: ReadonlySet<string>;
  cut: ReadonlySet<string>;
  status: ReadonlyMap<string, Status>;
  changedDirs: ReadonlySet<string>;
  editing: Editing | null;
  mark: string | null;
  arrived: ReadonlySet<string>;
  label: string;
  pointer: RowPointer;
  scroll: number;
  onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void;
  onFocusChange(focused: boolean): void;
  onScrolled(top: number): void;
  onContextMenu(event: React.MouseEvent<HTMLDivElement>): void;
  children?: ReactNode;
}) {
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    setHeight(el.clientHeight);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setHeight(el.clientHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, [listRef]);
  // jsdom and a list not laid out yet have no height: draw a screenful.
  const view = height || 600;
  // A window of one length for a given height, moved by whole blocks: the
  // same slots show other rows, none come or go while scrolling.
  const span = Math.ceil((Math.ceil(view / ROW) + 2 * OVERSCAN + BLOCK - 1) / BLOCK) * BLOCK;
  const first = Math.max(0, Math.min(Math.floor((scroll / ROW - OVERSCAN) / BLOCK) * BLOCK, Math.ceil((rows.length - span) / BLOCK) * BLOCK));
  const last = Math.min(rows.length, first + span);
  const indices: number[] = [];
  // The cursor's row is always drawn, so aria-activedescendant always points at something.
  if (cursor >= 0 && cursor < first) indices.push(cursor);
  for (let i = first; i < last; i++) indices.push(i);
  if (cursor >= last && cursor < rows.length) indices.push(cursor);
  const current = rows[cursor];

  return (
    <div
      ref={listRef}
      tabIndex={0}
      role="tree"
      aria-label={label}
      aria-multiselectable
      aria-activedescendant={current?.type === "entry" ? rowId(cursor) : undefined}
      data-rail-focus
      data-files-list
      data-cursor={current?.type === "entry" ? current.path : ""}
      data-rows={rows.length}
      onKeyDown={onKeyDown}
      onFocus={(event) => event.target === event.currentTarget && onFocusChange(true)}
      onBlur={(event) => event.target === event.currentTarget && onFocusChange(false)}
      onContextMenu={onContextMenu}
      onScroll={(event) => onScrolled(event.currentTarget.scrollTop)}
      className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain py-1 outline-none"
    >
      <div style={{ height: rows.length * ROW }} className="relative">
        {indices.map((index) => {
          const row = rows[index]!;
          // Entry rows are keyed by their slot in the window, so the same
          // elements show the next entries as it moves (nothing is added).
          const slot = index >= first && index < last ? `slot:${index - first}` : `cursor:${rowKey(row)}`;
          if (row.type === "note") return <NoteRow key={`note:${slot}`} index={index} row={row} />;
          if (row.type === "draft") return <DraftRow key={rowKey(row)} index={index} row={row} editing={editing} />;
          return (
            <EntryRow
              key={slot}
              index={index}
              row={row}
              isCursor={index === cursor}
              focused={index === cursor && focused}
              selected={selected.has(row.path)}
              cut={cut.has(row.path)}
              status={row.kind === "file" ? status.get(row.path) : undefined}
              changedInside={row.kind === "dir" && changedDirs.has(row.path)}
              editing={editing?.key === row.path ? editing : null}
              marked={mark === row.path}
              arrived={arrived.has(row.path)}
              pointer={pointer}
            />
          );
        })}
      </div>
      {children}
    </div>
  );
}

export const rowId = (index: number) => `helix-files-row-${index}`;
const place = (index: number, depth: number) => ({ transform: `translateY(${index * ROW}px)`, "--helix-files-depth": depth }) as React.CSSProperties;
const indent = (depth: number) => ({ paddingLeft: PAD + depth * INDENT });

const EntryRow = memo(function EntryRow({
  index,
  row,
  isCursor,
  focused,
  selected,
  cut,
  status,
  changedInside,
  editing,
  marked,
  arrived,
  pointer,
}: {
  index: number;
  row: Extract<Row, { type: "entry" }>;
  isCursor: boolean;
  focused: boolean;
  selected: boolean;
  cut: boolean;
  status: Status | undefined;
  changedInside: boolean;
  editing: Editing | null;
  marked: boolean;
  arrived: boolean;
  pointer: RowPointer;
}) {
  const dir = row.kind === "dir";
  // The same element can show another entry after a scroll: the chevron turns only for its own folder.
  const shown = useRef(row.path);
  const same = shown.current === row.path;
  shown.current = row.path;
  // Every element is always there and shown by its class (see BLOCK); the
  // cursor's bar and the depth guides are the row's pseudo-elements (tree.css).
  return (
    <div
      id={rowId(index)}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-expanded={dir ? row.open : undefined}
      aria-selected={selected}
      aria-current={isCursor ? "true" : undefined}
      data-index={index}
      data-path={row.path}
      data-cursor-row={isCursor ? "" : undefined}
      data-focused={focused ? "" : undefined}
      data-selected={selected ? "" : undefined}
      data-cut={cut ? "" : undefined}
      title={row.path}
      style={place(index, row.depth)}
      onMouseDown={(event) => pointer.down(index, event)}
      onClick={(event) => pointer.click(index, event)}
      onDoubleClick={() => !dir && pointer.open(index)}
      className={cn(
        "helix-files-row absolute inset-x-1 top-0 flex h-7 cursor-default select-none items-center rounded-md pr-2 text-[13px] leading-none",
        selected ? "helix-files-selected" : isCursor ? "bg-state-active" : "hover:bg-state-hover",
        isCursor && "helix-files-cursor",
        marked && "helix-files-mark",
      )}
    >
      <span className={cn("flex min-w-0 flex-1 items-center gap-1.5", arrived && "helix-files-arrive", cut && "opacity-45")} style={indent(row.depth)}>
        <span className={cn("flex w-3 shrink-0 justify-center text-muted-foreground", !dir && "invisible")}>
          <span className="helix-files-chevron" data-open={row.open ? "" : undefined} data-turn={same ? "" : undefined} />
        </span>
        <EntryIcon dir={dir} open={row.open} name={editing ? editing.value || row.name : row.name} className={dir ? (row.hidden ? "text-muted-foreground/70" : undefined) : row.hidden ? "opacity-60" : undefined} />
        {editing ? (
          <NameField editing={editing} selectStem />
        ) : (
          <span className={cn("min-w-0 truncate", row.hidden ? "text-muted-foreground" : "text-foreground", isCursor && "font-medium")}>
            {row.match ? <Name name={row.name} match={row.match} /> : row.name}
          </span>
        )}
        {row.link ? (
          <span title="A link" className="flex shrink-0 text-muted-foreground" data-link>
            <UiGlyph name="link" className="size-3" />
          </span>
        ) : null}
      </span>
      <span
        title={status?.label ?? (changedInside ? "Has changes" : undefined)}
        aria-label={!status && changedInside ? "Has changes" : undefined}
        className={cn("ml-2 flex w-3 shrink-0 items-center justify-center font-mono text-[11px]", status?.className, !status && changedInside && "helix-files-changed")}
      >
        {status ? status.letter : " "}
      </span>
    </div>
  );
});

/** The name with the search's matched letters marked. */
function Name({ name, match }: { name: string; match: readonly number[] | undefined }) {
  if (!match || match.length === 0) return <>{name}</>;
  const parts: ReactNode[] = [];
  let at = 0;
  for (let i = 0; i < match.length; i += 2) {
    const start = match[i]!;
    const end = match[i + 1]!;
    if (start > at) parts.push(name.slice(at, start));
    parts.push(
      <mark key={i} className="helix-files-match">
        {name.slice(start, end)}
      </mark>,
    );
    at = end;
  }
  if (at < name.length) parts.push(name.slice(at));
  return <>{parts}</>;
}

function NoteRow({ index, row }: { index: number; row: Extract<Row, { type: "note" }> }) {
  return (
    <div style={place(index, row.depth)} className="helix-files-row absolute inset-x-1 top-0 flex h-7 items-center rounded-md pr-2 text-xs" data-note={row.tone}>
      <span className="flex min-w-0 items-center gap-1.5" style={indent(row.depth)}>
        <span className="w-3 shrink-0" />
        {row.tone === "loading" ? (
          <span role="status" aria-label="Reading the folder" className="kit-skeleton block h-2.5 w-28 rounded-full" />
        ) : (
          <>
            {row.tone === "error" ? <UiGlyph name="warn" className="size-3.5 text-destructive" /> : null}
            <span className={cn("min-w-0 truncate", row.tone === "error" ? "text-destructive" : "text-muted-foreground")} title={row.text}>
              {row.text}
            </span>
          </>
        )}
      </span>
    </div>
  );
}

function DraftRow({ index, row, editing }: { index: number; row: Extract<Row, { type: "draft" }>; editing: Editing | null }) {
  if (!editing) return null;
  const folder = row.folder || editing.value.endsWith("/");
  return (
    <div style={place(index, row.depth)} className="helix-files-row absolute inset-x-1 top-0 flex h-7 items-center rounded-md bg-state-active pr-2 text-[13px]" data-draft>
      <span className="helix-files-arrive flex min-w-0 flex-1 items-center gap-1.5" style={indent(row.depth)}>
        <span className="w-3 shrink-0" />
        {folder ? <FolderIcon open={false} className="text-muted-foreground" /> : <FileIcon name={editing.value} />}
        <NameField editing={editing} placeholder={row.folder ? "Folder name" : "File name, or a/b/ for folders"} />
      </span>
    </div>
  );
}

/** A name being typed in place: Enter keeps it, Escape (or leaving the field) drops it. */
function NameField({ editing, selectStem = false, placeholder }: { editing: Editing; selectStem?: boolean; placeholder?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    if (selectStem) el.setSelectionRange(0, stemLength(el.value));
    // Only on mount: the selection is the user's after that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <input
      ref={input}
      value={editing.value}
      placeholder={placeholder}
      spellCheck={false}
      autoComplete="off"
      aria-label={placeholder ?? "New name"}
      data-files-field
      onChange={(event) => editing.change(event.target.value)}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter") {
          event.preventDefault();
          done.current = true;
          editing.submit(event.currentTarget.value);
        } else if (event.key === "Escape") {
          event.preventDefault();
          done.current = true;
          editing.cancel();
        }
      }}
      onBlur={() => {
        if (!done.current) editing.cancel();
      }}
      className="h-6 min-w-0 flex-1 rounded-[5px] border border-ring/60 bg-background px-1.5 text-[13px] text-foreground outline-none placeholder:text-muted-foreground/70"
    />
  );
}
