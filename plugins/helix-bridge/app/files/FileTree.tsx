// The rail's file tree: the thread's workspace as an expandable list the
// plugin draws, keyboard first and as good with the pointer. It reads and
// changes files only through a FilesSource (types.ts); the folders it has
// read live in filesStore, so opening the rail again draws at once and then
// refreshes what is open in one `list`. Beside the agent it can also hand
// rows to the thread, ask about them, have a file written, and show the
// agent's trail and the review (ThreadLink, agent.ts). docs/HELIX_FILES.md is
// the design.
import "./tree.css";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChangedFile, RailComment } from "../../server";
import { cn } from "@/lib/utils";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { Kbd, prefersReducedMotion, ProgressLine, SkeletonRows, useHotkeys, type Hotkey } from "../../kit";
import { startFlight } from "../../kit/handoff/flight";
import { railMemory } from "../rail/railMemory";
import { editorFocus } from "../rail/railStore";
import { agentRows, useAgentFiles, useMarks } from "./agent";
import { AskBox, type AskTarget } from "./AskBox";
import { patchDirs, filesCache, readDirs, useFilesVersion } from "./filesStore";
import { composerElement, DRAG_TYPE, draggedRows } from "./handoff";
import { UiGlyph } from "./icons";
import { ancestors, badName, flatten, freeName, insertEntry, joinPath, nameOf, parentOf, removeEntry, rowKey, searchRows, type Row } from "./model";
import { RowMenu, type MenuItem } from "./RowMenu";
import { ROW, TreeRows, type Editing, type RowPointer, type Status } from "./TreeRows";
import type { DirListing, FileEntry, FileOp, FilesSource, ThreadLink } from "./types";

export interface FileTreeHandle {
  /** Open the folders on the way (one `list`), put the cursor on the file and centre it. */
  reveal(path: string): void;
  /** Give the list the keyboard. */
  focus(): void;
}

export interface FileTreeProps {
  source: FilesSource;
  threadId: string;
  /** Close the rail. The tree then gives Helix the keyboard (`editorFocus`). */
  onLeave?(): void;
  /** The thread: send rows to it, ask about them, have files written, the agent's trail. Without it those are not offered. */
  link?: ThreadLink | null;
  /** The active review's files (the Changes tab's `useChanges`): status letters, and a dot on those not viewed. */
  changes?: readonly (Pick<ChangedFile, "path" | "status"> & { viewed?: boolean })[] | null;
  /** The review's comments (the Comments tab's `useComments`): open ones are counted on their files. */
  comments?: readonly Pick<RailComment, "path" | "state">[] | null;
  /** The `treeStaysOpen` setting: opening a file keeps the rail. */
  staysOpen?: boolean;
  /** The workspace's absolute path (`filesList`'s `root`): `c` copies absolute paths with it, relative ones without. */
  root?: string | null;
  handle?: { current: FileTreeHandle | null };
}

const STATUS: Record<ChangedFile["status"], Status> = {
  added: { letter: "A", className: "text-diff-added", label: "Added" },
  modified: { letter: "M", className: "text-muted-foreground", label: "Modified" },
  deleted: { letter: "D", className: "text-diff-removed", label: "Deleted" },
  renamed: { letter: "R", className: "text-muted-foreground", label: "Renamed" },
};
const EMPTY: ReadonlySet<string> = new Set();
const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/u.test(navigator.platform || navigator.userAgent);
/** How long the cursor rests on a closed folder before its listing is fetched. */
const PREFETCH_MS = 60;

type Confirm = { action: "trash" | "delete"; paths: string[] };
type Notice = { text: string; tone: "error" | "info"; at: number };
/** A name being typed in place. A new file can also carry what the agent should write in it (`about`, after Tab). */
type Draft = { kind: "create"; dir: string; folder: boolean; value: string; about: string | null; field: "name" | "about" } | { kind: "rename"; path: string; value: string };

export function FileTree({ source, threadId, onLeave, link = null, changes, comments, staysOpen = false, root = null, handle }: FileTreeProps) {
  const memory = railMemory(threadId).files;
  const version = useFilesVersion(threadId);
  const cache = filesCache(threadId);
  const listRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const [open, setOpenState] = useState<ReadonlySet<string>>(memory.open);
  const setOpen = (next: ReadonlySet<string>) => {
    memory.open = new Set(next);
    setOpenState(next);
  };
  const [showHidden, setShowHiddenState] = useState(memory.showHidden);
  const setShowHidden = (next: boolean) => {
    memory.showHidden = next;
    setShowHiddenState(next);
  };
  const [cursorPath, setCursorPath] = useState<string | null>(memory.cursor);
  const [selected, setSelected] = useState<ReadonlySet<string>>(EMPTY);
  const anchor = useRef<{ path: string; base: ReadonlySet<string> } | null>(null);
  /** Selecting a range (`v`): every move of the cursor takes the rows from where it started. */
  const [visual, setVisual] = useState(false);
  const [clip, setClipState] = useState(memory.clip);
  const setClip = (next: typeof clip) => {
    memory.clip = next;
    setClipState(next);
  };
  const [query, setQuery] = useState("");
  const searchOrigin = useRef<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [mark, setMark] = useState<string | null>(null);
  const [arrived, setArrived] = useState<ReadonlySet<string>>(EMPTY);
  const [focused, setFocused] = useState(false);
  /** `t`: the tree narrowed to the agent's files. */
  const [agentView, setAgentView] = useState(false);
  const [ask, setAsk] = useState<{ targets: AskTarget[]; top: number } | null>(null);
  /** Files the agent was asked to write, by path, until they exist: the folder the row shows in. */
  const [writing, setWriting] = useState<ReadonlyMap<string, string>>(new Map());
  const agent = useAgentFiles(link);
  const marks = useMarks(agent, changes, comments);
  const scope = usePortalScopeProps() as unknown as Record<string, string>;
  const pendingKey = useRef<{ key: string; at: number } | null>(null);
  /** Centre the cursor's row on the next layout (reveal, first open). */
  const centre = useRef(memory.scroll === null);
  // The list's scroll, for drawing only the rows in view. Set here with the
  // element's, so a scroll the tree makes is drawn in the same frame.
  const [scroll, setScroll] = useState(memory.scroll ?? 0);
  const scrollFrame = useRef(0);
  const scrollTo = (top: number) => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = Math.max(0, top);
    memory.scroll = el.scrollTop;
    setScroll(el.scrollTop);
  };
  useEffect(() => () => cancelAnimationFrame(scrollFrame.current), []);

  // ---- rows ----------------------------------------------------------------
  const searching = query.trim() !== "";
  const baseRows = useMemo(() => flatten(cache.dirs, open, showHidden), [version, open, showHidden]); // eslint-disable-line react-hooks/exhaustive-deps
  const agentList = agent?.files;
  const shownRows = useMemo(
    () => (agentView ? agentRows(agentList ?? []) : searching ? searchRows(cache.dirs, query, showHidden) : baseRows),
    [agentView, agentList, searching, query, baseRows, version, showHidden], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const rows = useMemo(() => {
    let out: Row[] = shownRows;
    // Inserted at the top of their folder's rows, when that folder is showing.
    const place = (dir: string, made: Row[]) => {
      const at = dir === "" ? 0 : out.findIndex((r) => r.type === "entry" && r.path === dir && r.open) + 1;
      if (dir !== "" && at === 0) return;
      const depth = dir === "" ? 0 : (out[at - 1]?.depth ?? 0) + 1;
      out = [...out.slice(0, at), ...made.map((r) => ({ ...r, depth })), ...out.slice(at)];
    };
    if (!agentView && !searching)
      for (const [path, dir] of writing) if (!indexOfPath(out, path)) place(dir, [{ type: "entry", path, name: path.slice(dir ? dir.length + 1 : 0), depth: 0, kind: "file", link: false, open: false, hidden: false, state: "writing" }]);
    if (draft?.kind === "create") {
      const made: Row[] = [{ type: "draft", key: "draft", depth: 0, dir: draft.dir, folder: draft.folder }];
      if (draft.about !== null) made.push({ type: "draft", key: "draft:about", depth: 0, dir: draft.dir, folder: false });
      place(draft.dir, made);
    }
    return out;
  }, [shownRows, draft, writing, agentView, searching]);
  const indexOf = useMemo(() => {
    const map = new Map<string, number>();
    rows.forEach((r, i) => map.set(rowKey(r), i));
    return map;
  }, [rows]);

  // The cursor is a path; a row that went away leaves it at the same place in the list.
  const lastAt = useRef(0);
  const found = cursorPath === null ? undefined : indexOf.get(cursorPath);
  let at = found ?? Math.min(lastAt.current, rows.length - 1);
  if (draft?.kind === "create") at = indexOf.get(draft.field === "about" ? "draft:about" : "draft") ?? at;
  else if (found === undefined && rows[at]?.type !== "entry") at = nearestStop(rows, at);
  if (rows.length > 0 && at >= 0) lastAt.current = at;
  const currentRow = rows[at];
  const current = currentRow?.type === "entry" ? currentRow : null;

  const setCursor = useCallback(
    (path: string | null) => {
      memory.cursor = path;
      setCursorPath(path);
    },
    [memory],
  );
  const cursorTo = (index: number) => {
    const row = rows[index];
    if (row?.type === "entry") setCursor(row.path);
  };

  /** The folder the cursor is on when it is open, else the one holding its row. */
  const cursorFolder = (): string => (current ? (current.kind === "dir" && current.open && !searching && !agentView ? current.path : parentOf(current.path)) : "");
  /** The selection, or the cursor's row. */
  const targets = (): string[] => (selected.size > 0 ? [...selected] : current ? [current.path] : []);

  const status = useMemo(() => new Map((changes ?? []).map((c) => [c.path, STATUS[c.status]])), [changes]);
  const changedDirs = useMemo(() => {
    const dirs = new Set<string>();
    for (const c of changes ?? []) for (const d of ancestors(c.path)) if (d) dirs.add(d);
    return dirs;
  }, [changes]);
  const cut = useMemo(() => (clip?.mode === "move" ? new Set(clip.paths) : EMPTY), [clip]);

  // ---- reading -------------------------------------------------------------
  /** The open folders that are showing (their parents are open too), and the workspace. */
  const visibleOpen = useCallback((openSet: ReadonlySet<string>) => ["", ...[...openSet].filter((p) => ancestors(p).every((a) => a === "" || openSet.has(a)))], []);
  const openRef = useRef(open);
  openRef.current = open;
  const writingRef = useRef(writing);
  writingRef.current = writing;

  // Opening the rail: drawn from the cache already; now every open folder, in one `list`.
  useEffect(() => {
    void readDirs(threadId, source, visibleOpen(openRef.current), true);
  }, [threadId, source, visibleOpen]);

  // Someone else changed files: read again what is showing of it.
  useEffect(
    () =>
      source.onChanged((dirs) => {
        const showing = new Set(visibleOpen(openRef.current));
        // The folders of files being written are read too, to see them arrive.
        for (const path of writingRef.current.keys()) showing.add(parentOf(path));
        const wanted = dirs === null ? [...showing] : dirs.filter((d) => showing.has(d));
        if (wanted.length) void readDirs(threadId, source, wanted);
      }),
    [threadId, source, visibleOpen],
  );

  // Prefetch: the cursor resting on a closed folder fetches its listing, so `l` has it.
  const restingOn = current && current.kind === "dir" && !current.open && !cache.dirs.has(current.path) ? current.path : null;
  useEffect(() => {
    if (!restingOn) return;
    const timer = window.setTimeout(() => void readDirs(threadId, source, [restingOn]), PREFETCH_MS);
    return () => window.clearTimeout(timer);
  }, [restingOn, threadId, source]);

  const refreshing = cache.reading.size > 0 && cache.dirs.has("");

  // ---- notices -------------------------------------------------------------
  const say = (text: string, tone: Notice["tone"] = "info") => setNotice({ text, tone, at: Date.now() });
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice((n) => (n === notice ? null : n)), notice.tone === "error" ? 8000 : 2500);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const flashArrived = (paths: string[], target: string | null) => {
    setArrived(new Set(paths));
    setMark(target);
    window.setTimeout(() => {
      setArrived(EMPTY);
      setMark(null);
    }, 720);
  };

  // ---- folders -------------------------------------------------------------
  const openFolder = (path: string) => {
    if (open.has(path)) return;
    const next = new Set(open);
    next.add(path);
    setOpen(next);
    // From the cache it is drawn now and read again behind; otherwise read now.
    void readDirs(threadId, source, [path], cache.dirs.has(path));
  };
  const closeFolder = (path: string) => {
    if (!open.has(path)) return;
    const next = new Set(open);
    next.delete(path);
    setOpen(next);
  };
  const toggleFolder = (path: string) => (open.has(path) ? closeFolder(path) : openFolder(path));

  const focusList = () => listRef.current?.focus({ preventScroll: true });

  const reveal = (path: string) => {
    const clean = path.replace(/^\/+|\/+$/gu, "");
    if (!clean) return;
    setQuery("");
    setDraft(null);
    const folders = ancestors(clean).filter(Boolean);
    const next = new Set(open);
    for (const f of folders) next.add(f);
    setOpen(next);
    if (clean.split("/").some((p) => p.startsWith(".")) && !showHidden) setShowHidden(true);
    const missing = ["", ...folders].filter((d) => !cache.dirs.has(d));
    if (missing.length) void readDirs(threadId, source, missing);
    centre.current = true;
    setCursor(clean);
  };

  const leave = () => {
    onLeave?.();
    editorFocus.get(threadId)?.();
  };
  const openFile = (path: string) => {
    memory.cursor = path;
    source.open(path).catch((cause: unknown) => say(`${nameOf(path)} did not open: ${message(cause)}`, "error"));
    if (!staysOpen) leave();
  };

  // ---- operations ----------------------------------------------------------
  /** Patches the cache now, runs the operation, puts things back if the host refuses, and reads again. */
  const run = async (op: FileOp, patches: Map<string, DirListing | undefined>, touched: string[], undo?: () => void): Promise<string[] | null> => {
    const before = patchDirs(threadId, patches);
    let result;
    try {
      result = await source.op(op);
    } catch (cause) {
      result = { ok: false, error: message(cause), paths: [] };
    }
    if (!result.ok) {
      patchDirs(threadId, before);
      undo?.();
      say(result.error ?? "That did not work", "error");
    }
    void readDirs(threadId, source, [...new Set([...touched, ...before.keys()])].filter((d) => d === "" || cache.dirs.has(d) || openRef.current.has(d)), true);
    return result.ok ? result.paths : null;
  };
  const listing = (dir: string): DirListing | undefined => cache.dirs.get(dir);
  const entryOf = (path: string): FileEntry => listing(parentOf(path))?.entries.find((e) => e.name === nameOf(path)) ?? { name: nameOf(path), kind: "file" };

  const startCreate = (folder: boolean) => {
    const dir = cursorFolder();
    setQuery("");
    setMenu(null);
    if (dir && !open.has(dir)) openFolder(dir);
    setAgentView(false);
    setDraft({ kind: "create", dir, folder, value: "", about: null, field: "name" });
  };
  const create = async (dir: string, input: string, folderDraft: boolean) => {
    const problem = badName(input, true);
    if (problem) {
      say(problem, "error");
      return false;
    }
    const isDir = folderDraft || input.endsWith("/");
    const clean = input.replace(/\/+$/u, "");
    const parts = clean.split("/");
    const full = joinPath(dir, clean);
    if (listing(parentOf(full))?.entries.some((e) => e.name === nameOf(full))) {
      say(`${nameOf(full)} is already there`, "error");
      return false;
    }
    const patches = new Map<string, DirListing | undefined>();
    const nextOpen = new Set(open);
    let parent = dir;
    for (let i = 0; i < parts.length; i++) {
      const entry: FileEntry = { name: parts[i]!, kind: i < parts.length - 1 || isDir ? "dir" : "file" };
      const have = patches.get(parent) ?? listing(parent) ?? (i > 0 ? { entries: [], error: null, truncated: false } : undefined);
      if (have && !have.entries.some((e) => e.name === entry.name && e.kind === "dir")) patches.set(parent, insertEntry(have, entry));
      if (i < parts.length - 1) {
        parent = joinPath(parent, parts[i]!);
        nextOpen.add(parent);
      }
    }
    if (dir) nextOpen.add(dir);
    const previous = cursorPath;
    setDraft(null);
    setOpen(nextOpen);
    setCursor(full);
    flashArrived([full], null);
    const made = await run({ kind: "create", path: isDir ? `${full}/` : full }, patches, [dir, ...ancestors(full).filter((d) => d.startsWith(dir))], () => {
      setCursor(previous);
      setDraft({ kind: "create", dir, folder: folderDraft, value: input, about: null, field: "name" });
    });
    if (made?.[0]) setCursor(made[0]);
    focusList();
    return true;
  };

  /** Tab in the new-file field: ask the agent to write it instead. Not for folders. */
  const writeFile = async (dir: string, input: string, about: string) => {
    if (!link) return;
    const problem = badName(input, true) ?? (input.endsWith("/") ? "The agent writes files; a name ending in / is a folder" : null);
    if (problem) return say(problem, "error");
    const full = joinPath(dir, input);
    if (listing(parentOf(full))?.entries.some((e) => e.name === nameOf(full))) return say(`${nameOf(full)} is already there`, "error");
    setDraft(null);
    const next = new Map(writing);
    next.set(full, dir);
    setWriting(next);
    setCursor(full);
    focusList();
    const sent = await link.write(full, about);
    if (sent.ok) say(`Sent to ${threadTitle}: write ${nameOf(full)}`);
    else {
      setWriting((w) => {
        const m = new Map(w);
        m.delete(full);
        return m;
      });
      setDraft({ kind: "create", dir, folder: false, value: input, about, field: "about" });
      say(sent.error ?? "The thread did not take it", "error");
    }
  };
  // A file being written is done when its folder lists it: Helix opens it, and it arrives in place.
  useEffect(() => {
    if (writing.size === 0) return;
    const done = [...writing.keys()].filter((path) => cache.dirs.get(parentOf(path))?.entries.some((e) => e.name === nameOf(path)));
    if (done.length === 0) return;
    setWriting((w) => {
      const m = new Map(w);
      for (const path of done) m.delete(path);
      return m;
    });
    const next = new Set(open);
    for (const path of done) for (const f of ancestors(path)) if (f) next.add(f);
    setOpen(next);
    flashArrived(done, null);
    for (const path of done) void source.open(path).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const startRename = () => {
    if (!current) return;
    setMenu(null);
    setDraft({ kind: "rename", path: current.path, value: current.name });
  };
  const rename = async (path: string, name: string) => {
    if (name === nameOf(path)) {
      setDraft(null);
      focusList();
      return;
    }
    const problem = badName(name, false);
    if (problem) {
      say(problem, "error");
      return;
    }
    const dir = parentOf(path);
    const to = joinPath(dir, name);
    const have = listing(dir);
    if (have?.entries.some((e) => e.name === name)) {
      say(`${name} is already there`, "error");
      return;
    }
    const entry = entryOf(path);
    const patches = new Map<string, DirListing | undefined>();
    if (have) patches.set(dir, insertEntry(removeEntry(have, entry.name), { ...entry, name }));
    moveCached(path, to, patches);
    const previousOpen = open;
    setOpen(renamePrefix(open, path, to));
    setDraft(null);
    setCursor(to);
    focusList();
    const done = await run({ kind: "rename", from: path, to }, patches, [dir], () => {
      setOpen(previousOpen);
      setCursor(path);
    });
    if (done?.[0]) setCursor(done[0]);
  };
  /** A folder's cached listings follow it to its new path. */
  const moveCached = (from: string, to: string, patches: Map<string, DirListing | undefined>) => {
    for (const [key, value] of cache.dirs) {
      if (key !== from && !key.startsWith(`${from}/`)) continue;
      patches.set(key, undefined);
      patches.set(to + key.slice(from.length), value);
    }
  };

  const yank = (mode: "copy" | "move") => {
    const paths = targets();
    if (paths.length === 0) return;
    setClip({ mode, paths });
    setSelected(EMPTY);
  };
  const paste = async () => {
    if (!clip) return;
    const into = cursorFolder();
    const inside = clip.paths.find((p) => into === p || into.startsWith(`${p}/`));
    if (inside) {
      say(`${nameOf(inside)} cannot go inside itself`, "error");
      return;
    }
    const patches = new Map<string, DirListing | undefined>();
    const target = listing(into);
    const taken = new Set(target?.entries.map((e) => e.name) ?? []);
    let next = target;
    const predicted: string[] = [];
    const moving = clip.mode === "move" ? clip.paths.filter((p) => parentOf(p) !== into) : clip.paths;
    for (const from of moving) {
      const entry = entryOf(from);
      const name = freeName(taken, entry.name);
      taken.add(name);
      predicted.push(joinPath(into, name));
      if (next) next = insertEntry(next, { ...entry, name });
      if (clip.mode === "move") {
        const parent = parentOf(from);
        const have = patches.get(parent) ?? listing(parent);
        if (have && parent !== into) patches.set(parent, removeEntry(have, entry.name));
        moveCached(from, joinPath(into, name), patches);
      }
    }
    if (next) patches.set(into, next);
    if (into && !open.has(into)) openFolder(into);
    const previous = cursorPath;
    if (predicted[0]) setCursor(predicted[0]);
    flashArrived(predicted, into || null);
    const wasClip = clip;
    if (clip.mode === "move") setClip(null);
    const done = await run({ kind: clip.mode, from: clip.paths, into }, patches, [into, ...clip.paths.map(parentOf)], () => {
      setCursor(previous);
      if (wasClip.mode === "move") setClip(wasClip);
    });
    if (done?.[0]) setCursor(done[0]);
  };

  const askRemove = (action: Confirm["action"]) => {
    const paths = targets();
    if (paths.length === 0) return;
    setMenu(null);
    setConfirm({ action, paths });
  };
  const remove = async ({ action, paths }: Confirm) => {
    setConfirm(null);
    focusList();
    const patches = new Map<string, DirListing | undefined>();
    for (const path of paths) {
      const parent = parentOf(path);
      const have = patches.get(parent) ?? listing(parent);
      if (have) patches.set(parent, removeEntry(have, nameOf(path)));
    }
    // The cursor goes to the row after what goes away (or before it, at the end).
    const gone = (p: string) => paths.some((r) => p === r || p.startsWith(`${r}/`));
    const lastGone = Math.max(...paths.map((p) => indexOf.get(p) ?? -1));
    const after = rows.slice(lastGone + 1).find((r) => r.type === "entry" && !gone(r.path));
    const before = [...rows.slice(0, Math.max(0, lastGone))].reverse().find((r) => r.type === "entry" && !gone(r.path));
    const previous = cursorPath;
    const landing = (after ?? before) as Extract<Row, { type: "entry" }> | undefined;
    setCursor(landing?.path ?? null);
    const previousSelection = selected;
    setSelected(EMPTY);
    if (clip) setClip(clip.paths.some(gone) ? (clip.paths.filter((p) => !gone(p)).length ? { ...clip, paths: clip.paths.filter((p) => !gone(p)) } : null) : clip);
    await run({ kind: action, paths }, patches, paths.map(parentOf), () => {
      setCursor(previous);
      setSelected(previousSelection);
    });
  };

  // ---- the thread ----------------------------------------------------------
  const threadTitle = link?.thread.title ?? "the thread";
  const kindOf = (path: string): "file" | "dir" => {
    const row = rows[indexOf.get(path) ?? -1];
    return row?.type === "entry" ? row.kind : entryOf(path).kind;
  };
  /** Folders end with `/` in what goes to the thread's composer (ThreadLink's paths carry no kind). */
  const asMentions = (paths: string[]) => paths.map((p) => (kindOf(p) === "dir" ? `${p}/` : p));
  const rowElements = (paths: string[]) => paths.map((p) => listRef.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(p)}"]`)).filter((el): el is HTMLElement => Boolean(el));

  /** `s`: the rows go to the thread's composer as mentions, with the suite's flight to it. */
  const sendToThread = async () => {
    const paths = targets();
    if (!link || paths.length === 0) return;
    setMenu(null);
    let flight: ReturnType<typeof startFlight> | null = null;
    try {
      if (!prefersReducedMotion()) flight = startFlight({ sources: rowElements(paths), origin: listRef.current, target: () => composerElement(threadId), label: paths.length === 1 ? nameOf(paths[0]!) : `${paths.length} entries`, scope });
    } catch {
      flight = null;
    }
    const sent = await link.mention(asMentions(paths));
    if (!sent.ok) {
      await flight?.returnHome();
      return say(sent.error ?? "The composer did not take them", "error");
    }
    await flight?.finished;
    setSelected(EMPTY);
    say(`Sent to ${threadTitle}`);
    // The chat has the keyboard now; the rail goes away.
    onLeave?.();
  };

  /** `i`: the Ask box on the cursor's row. */
  const startAsk = () => {
    const paths = targets();
    if (!link || paths.length === 0) return;
    setMenu(null);
    const rowEl = listRef.current?.querySelector<HTMLElement>("[data-cursor-row]")?.getBoundingClientRect();
    const box = boxRef.current?.getBoundingClientRect();
    setAsk({ targets: paths.map((path) => ({ path, kind: kindOf(path) })), top: rowEl && box ? rowEl.bottom - box.top + 4 : 48 });
  };
  const sendAsk = async (text: string): Promise<boolean> => {
    if (!link || !ask) return false;
    const sent = await link.ask(ask.targets.map((t) => t.path), text);
    if (!sent.ok) {
      say(sent.error ?? "The thread did not take it", "error");
      return false;
    }
    setAsk(null);
    setSelected(EMPTY);
    say(`Sent to ${threadTitle}`);
    // The chat shows the answer as it comes; the rail goes away.
    onLeave?.();
    return true;
  };

  /** `t`: the agent's files and back. */
  const toggleAgentView = () => {
    if (!link) return;
    setMenu(null);
    if (agentView) return endAgentView();
    setQuery("");
    setDraft(null);
    setAgentView(true);
    const first = agentRows(agent?.files ?? []).find((r) => r.type === "entry" && r.kind === "file");
    if (first?.type === "entry") setCursor(first.path);
  };
  /** Back to the whole tree, on the row the cursor is on, its folders open. */
  const endAgentView = () => {
    setAgentView(false);
    if (current && current.state !== "deleted") {
      const next = new Set(open);
      for (const f of ancestors(current.path)) if (f) next.add(f);
      setOpen(next);
      const missing = ancestors(current.path).filter((d) => !cache.dirs.has(d));
      if (missing.length) void readDirs(threadId, source, missing);
      centre.current = true;
    }
  };

  const newThreadHere = () => {
    if (!link?.newThread || !current) return;
    setMenu(null);
    link.newThread(asMentions([current.kind === "dir" ? current.path : parentOf(current.path) || current.path]));
  };

  const onDragStart = (event: React.DragEvent<HTMLDivElement>) => {
    const rowEl = (event.target as HTMLElement).closest<HTMLElement>("[data-path]");
    const path = rowEl?.dataset.path;
    if (!path || !link) return event.preventDefault();
    const paths = selected.has(path) ? [...selected] : [path];
    event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(asMentions(paths)));
    event.dataTransfer.effectAllowed = "copy";
    draggedRows.set(asMentions(paths));
  };

  const copyPath = (path: string) => {
    const text = root ? `${root.replace(/\/+$/u, "")}/${path}` : path;
    const done = () => say(`Copied ${text}`);
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, () => say("The clipboard refused the path", "error"));
    else say("No clipboard here", "error");
  };

  const toggleHidden = () => {
    setShowHidden(!showHidden);
    say(showHidden ? "Dot files hidden" : "Dot files shown");
  };

  // ---- the cursor ----------------------------------------------------------
  const page = () => Math.max(1, Math.floor((listRef.current?.clientHeight || 600) / ROW) - 1);
  const move = (delta: number, extend = false) => {
    let i = at;
    const step = delta > 0 ? 1 : -1;
    let left = Math.abs(delta);
    let target = at;
    while (left > 0) {
      i += step;
      if (i < 0 || i >= rows.length) break;
      if (rows[i]!.type === "entry") {
        target = i;
        left--;
      }
    }
    if (target === at && Math.abs(delta) === 1) return;
    const row = rows[target];
    if (row?.type !== "entry") return;
    if (extend && current) {
      anchor.current ??= { path: current.path, base: selected };
      selectRange(anchor.current.path, row.path, anchor.current.base);
    } else if (!visual) anchor.current = null;
    setCursor(row.path);
  };
  /** `v`: start selecting from the cursor's row; again (or Escape) to stop, with the selection kept for the next key. */
  const toggleVisual = () => {
    if (visual) return setVisual(false);
    if (!current) return;
    anchor.current = { path: current.path, base: selected };
    selectRange(current.path, current.path, selected);
    setVisual(true);
  };
  // While selecting, the range follows the cursor however it moved (keys, a page, a click).
  const currentPath = current?.path ?? null;
  useEffect(() => {
    if (!visual || currentPath === null || !anchor.current) return;
    selectRange(anchor.current.path, currentPath, anchor.current.base);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visual, currentPath]);
  // An action took the selection (copy, trash, send): selecting is over.
  useEffect(() => {
    if (visual && selected.size === 0) setVisual(false);
  }, [visual, selected]);
  const selectRange = (from: string, to: string, base: ReadonlySet<string>) => {
    const a = indexOf.get(from) ?? at;
    const b = indexOf.get(to) ?? at;
    const next = new Set(base);
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
      const r = rows[i];
      if (r?.type === "entry") next.add(r.path);
    }
    setSelected(next);
  };
  const firstStop = () => rows.findIndex((r) => r.type === "entry");
  const lastStop = () => rows.length - 1 - [...rows].reverse().findIndex((r) => r.type === "entry");

  const toggleSelect = () => {
    if (!current) return;
    const next = new Set(selected);
    if (next.has(current.path)) next.delete(current.path);
    else next.add(current.path);
    setSelected(next);
    move(1);
  };

  const enter = () => {
    if (!current) return;
    if (current.state === "deleted") return say(`The agent deleted ${current.name}`);
    if (current.state === "writing") return say(`${current.name} is being written by ${threadTitle}`);
    if (current.kind === "file") openFile(current.path);
    else if (searching) {
      endSearch(true);
    } else toggleFolder(current.path);
  };
  const right = () => {
    if (!current) return;
    // In a search's results a folder shows only what matched: opening it there
    // would show nothing, so `l` does what Enter does (out of the search, on it, open).
    if (current.kind === "file" || searching) return enter();
    if (!current.open) return openFolder(current.path);
    const next = rows[at + 1];
    if (next?.type === "entry" && next.depth > current.depth) setCursor(next.path);
  };
  const left = () => {
    if (!current) return;
    if (current.kind === "dir" && current.open && !searching && !agentView) return closeFolder(current.path);
    const parent = parentOf(current.path);
    if (parent && indexOf.has(parent)) setCursor(parent);
  };

  // ---- search --------------------------------------------------------------
  const startSearch = () => {
    setMenu(null);
    setAgentView(false);
    searchRef.current?.focus();
    searchRef.current?.select();
  };
  /** Leave the search; `keep`: stay on the row the cursor is on now, with its folders open. */
  const endSearch = (keep: boolean) => {
    const origin = searchOrigin.current;
    searchOrigin.current = null;
    setQuery("");
    if (keep && current) {
      const next = new Set(open);
      for (const f of ancestors(current.path)) if (f) next.add(f);
      if (current.kind === "dir") next.add(current.path);
      setOpen(next);
      centre.current = true;
    } else if (!keep && origin !== null) {
      setCursor(origin);
      centre.current = true;
    }
  };
  const firstMatch = (list: readonly Row[]) => list.find((r) => r.type === "entry" && r.match) as Extract<Row, { type: "entry" }> | undefined;
  // As the search is typed, the cursor is on its first match.
  useEffect(() => {
    if (!searching) return;
    const hit = firstMatch(shownRows);
    if (hit) setCursor(hit.path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  // ---- keys ----------------------------------------------------------------
  const escape = (): boolean => {
    if (menu) return setMenu(null), true;
    if (confirm) return setConfirm(null), true;
    if (ask) return setAsk(null), true;
    if (visual) return setVisual(false), true;
    if (searching) return endSearch(true), true;
    if (agentView) return endAgentView(), true;
    if (clip) return setClip(null), true;
    if (selected.size > 0) return setSelected(EMPTY), (anchor.current = null), true;
    leave();
    return true;
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // Keys typed in a field of a row belong to the field.
    if (event.target !== event.currentTarget || event.defaultPrevented || event.nativeEvent.isComposing) return;
    const k = event.key;
    const mod = isMac ? event.metaKey : event.ctrlKey;
    const ctrl = event.ctrlKey && !event.metaKey;
    const shift = event.shiftKey;
    const again = pendingKey.current;
    pendingKey.current = null;
    const handled = () => event.preventDefault();

    // Ctrl-d, Ctrl-u: the Control key on every system (Cmd-d is bb's).
    if (ctrl && !event.altKey && (k === "d" || k === "u")) {
      const half = Math.ceil(page() / 2) * (k === "d" ? 1 : -1);
      return handled(), move(half), scrollBy(half);
    }
    if (mod && !event.altKey) {
      const key = k.toLowerCase();
      if (key === "c") return handled(), yank("copy");
      if (key === "x") return handled(), yank("move");
      if (key === "v") return handled(), void paste();
      if (k === "Backspace") return handled(), askRemove("trash");
      return;
    }
    if (event.metaKey || event.altKey || event.ctrlKey) return;

    switch (k) {
      case "j":
      case "ArrowDown":
        return handled(), move(1, shift);
      case "J":
        return handled(), move(1, true);
      case "k":
      case "ArrowUp":
        return handled(), move(-1, shift);
      case "K":
        return handled(), move(-1, true);
      case "l":
      case "ArrowRight":
        return handled(), right();
      case "h":
      case "ArrowLeft":
        return handled(), left();
      case "g":
        handled();
        if (again?.key === "g" && Date.now() - again.at < 800) cursorTo(firstStop());
        else pendingKey.current = { key: "g", at: Date.now() };
        return;
      case "Home":
        return handled(), cursorTo(firstStop());
      case "G":
      case "End":
        return handled(), cursorTo(lastStop());
      case "PageDown":
        return handled(), move(page()), scrollBy(page());
      case "PageUp":
        return handled(), move(-page()), scrollBy(-page());
      case "Enter":
        return handled(), enter();
      case "/":
        return handled(), startSearch();
      case "a":
        return handled(), startCreate(false);
      case "A":
        return handled(), startCreate(true);
      case "r":
      case "F2":
        return handled(), startRename();
      case "y":
        return handled(), yank("copy");
      case "x":
        return handled(), yank("move");
      case "p":
        return handled(), void paste();
      case " ":
        return handled(), toggleSelect();
      case "v":
        return handled(), toggleVisual();
      case "d":
      case "Backspace":
      case "Delete":
        return handled(), askRemove("trash");
      case "D":
        return handled(), askRemove("delete");
      case ".":
        return handled(), toggleHidden();
      case "c":
        return current ? (handled(), copyPath(current.path)) : undefined;
      case "s":
        return link ? (handled(), void sendToThread()) : undefined;
      case "i":
        return link ? (handled(), startAsk()) : undefined;
      case "t":
        return link ? (handled(), toggleAgentView()) : undefined;
      case "ContextMenu":
        return handled(), openMenuAtCursor();
      case "F10":
        return shift ? (handled(), openMenuAtCursor()) : undefined;
      case "Escape":
        return handled(), void escape();
    }
  };
  const scrollBy = (rowsCount: number) => {
    const el = listRef.current;
    if (el) scrollTo(el.scrollTop + rowsCount * ROW);
  };

  // The `?` sheet lists the tree's keys. The list handles them itself (above):
  // these entries only describe, and never take a key from anything else.
  const described = (key: string | string[], description: string): Hotkey => ({ key, description, group: "Files", handler: () => {}, preventDefault: false });
  useHotkeys(
    [
      described(["j", "k"], "Down, up (Shift extends the selection)"),
      described(["l", "h"], "Open, close a folder; first child, parent"),
      described(["Enter"], "Open the file in Helix, or the folder"),
      described(["g g", "shift+g"], "First, last row"),
      described(["ctrl+d", "ctrl+u"], "Half a page down, up"),
      described(["/"], "Search the folders opened"),
      described(["a", "shift+a"], "New file, new folder"),
      described(["r", "F2"], "Rename"),
      described(["y", "mod+c"], "Copy"),
      described(["x", "mod+x"], "Cut"),
      described(["p", "mod+v"], "Paste into the cursor's folder"),
      described(["Space"], "Select and go down"),
      described(["v"], "Select a range: move to take rows, then act on them all; v or Escape stops"),
      described(["d", "Backspace"], "Move to the trash"),
      described(["shift+d"], "Delete for good"),
      described(["."], "Show or hide dot files"),
      described(["c"], "Copy the path"),
      ...(link
        ? [
            described(["s"], "Send to thread (as mentions in its composer)"),
            described(["i"], "Ask the thread about it"),
            described(["t"], "The agent's files, and back"),
            described(["Tab"], "In a new file's name: have the agent write it"),
          ]
        : []),
      described(["Escape"], "Back one step, then close"),
    ],
    { scope: listRef },
  );

  // ---- the pointer ---------------------------------------------------------
  const live = useRef({ rows, at, selected, open, searching });
  live.current = { rows, at, selected, open, searching };
  const actions = useRef({ toggleFolder, openFile, setSelected, setCursor, selectRange });
  actions.current = { toggleFolder, openFile, setSelected, setCursor, selectRange };
  const pointer = useMemo<RowPointer>(
    () => ({
      down(index, event) {
        if (event.button !== 0) return;
        const { rows, at, selected } = live.current;
        const row = rows[index];
        if (row?.type !== "entry") return;
        const a = actions.current;
        if (isMac ? event.metaKey : event.ctrlKey) {
          const next = new Set(selected);
          if (next.has(row.path)) next.delete(row.path);
          else next.add(row.path);
          a.setSelected(next);
        } else if (event.shiftKey) {
          const from = rows[at];
          if (from?.type === "entry") a.selectRange(from.path, row.path, selected);
          event.preventDefault();
        }
        a.setCursor(row.path);
      },
      click(index, event) {
        const { rows, searching } = live.current;
        const row = rows[index];
        if (row?.type !== "entry" || row.kind !== "dir" || event.metaKey || event.ctrlKey || event.shiftKey || searching) return;
        actions.current.toggleFolder(row.path);
      },
      open(index) {
        const row = live.current.rows[index];
        if (row?.type === "entry" && row.kind === "file") actions.current.openFile(row.path);
      },
    }),
    [],
  );

  const openMenuAtCursor = () => {
    const box = boxRef.current?.getBoundingClientRect();
    const rowEl = listRef.current?.querySelector<HTMLElement>("[data-cursor-row]")?.getBoundingClientRect();
    if (!box) return;
    setMenu({ x: rowEl ? rowEl.left - box.left + 24 : 16, y: rowEl ? rowEl.bottom - box.top + 2 : 48 });
  };
  const onContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const rowEl = (event.target as HTMLElement).closest<HTMLElement>("[data-index]");
    // From the keyboard (Shift-F10) the event is on the list itself.
    if (!rowEl || event.target === event.currentTarget) return openMenuAtCursor();
    const row = rows[Number(rowEl.dataset.index)];
    if (row?.type === "entry") {
      setCursor(row.path);
      if (!selected.has(row.path)) setSelected(EMPTY);
    }
    const box = boxRef.current!.getBoundingClientRect();
    setMenu({ x: event.clientX - box.left, y: event.clientY - box.top });
  };
  const closeMenu = () => {
    setMenu(null);
    focusList();
  };
  const menuItems: MenuItem[] = [
    ...(link
      ? [
          { label: "Send to thread", combo: "s", run: () => void sendToThread(), disabled: !current },
          { label: "Ask about it", combo: "i", run: startAsk, disabled: !current },
          ...(link.newThread && current?.kind === "dir" ? [{ label: "New thread here", combo: "", run: newThreadHere }] : []),
        ]
      : []),
    { label: "New file", combo: "a", run: () => startCreate(false), separated: Boolean(link) },
    { label: "New folder", combo: "shift+a", run: () => startCreate(true) },
    { label: "Rename", combo: "F2", run: startRename, disabled: !current, separated: true },
    { label: "Copy", combo: "mod+c", run: () => yank("copy"), disabled: !current },
    { label: "Cut", combo: "mod+x", run: () => yank("move"), disabled: !current },
    { label: "Paste", combo: "mod+v", run: () => void paste(), disabled: !clip },
    { label: "Copy path", combo: "c", run: () => current && copyPath(current.path), disabled: !current, separated: true },
    { label: showHidden ? "Hide dot files" : "Show dot files", combo: ".", run: toggleHidden },
    { label: "Move to trash", combo: "Backspace", run: () => askRemove("trash"), disabled: !current, destructive: true, separated: true },
  ];

  // ---- the handle ----------------------------------------------------------
  const revealRef = useRef(reveal);
  revealRef.current = reveal;
  useEffect(() => {
    if (!handle) return;
    const mine: FileTreeHandle = { reveal: (path) => revealRef.current(path), focus: focusList };
    handle.current = mine;
    return () => {
      if (handle.current === mine) handle.current = null;
    };
  }, [handle]);

  // ---- scroll --------------------------------------------------------------
  // Back where it was: the scroll the rail closed with, before the first paint.
  const listShown = cache.dirs.has("");
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && memory.scroll !== null) scrollTo(memory.scroll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listShown]);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el || at < 0 || rows.length === 0) return;
    const top = at * ROW + 4;
    const height = el.clientHeight;
    if (centre.current) {
      // A path whose folders are still being read: centre it once they are.
      if (cursorPath !== null && found === undefined && ancestors(cursorPath).some((d) => !cache.dirs.has(d))) return;
      centre.current = false;
      if (height) scrollTo(top - height / 2 + ROW / 2);
      return;
    }
    if (top < el.scrollTop) scrollTo(top - 4);
    else if (height && top + ROW > el.scrollTop + height) scrollTo(top + ROW - height + 4);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at, rows.length, found, cursorPath]);

  // ---- drawing -------------------------------------------------------------
  const editing: Editing | null = draft
    ? {
        key: draft.kind === "create" ? "draft" : draft.path,
        value: draft.value,
        change: (value) => setDraft((d) => (d ? { ...d, value } : d)),
        cancel: () => {
          setDraft(null);
          focusList();
        },
        submit: (value) => {
          if (draft.kind === "rename") return void rename(draft.path, value);
          if (draft.about?.trim()) void writeFile(draft.dir, draft.value, draft.about.trim());
          else void create(draft.dir, draft.value, draft.folder);
        },
        ...(draft.kind === "create"
          ? {
              about: draft.about,
              field: draft.field,
              changeAbout: (about: string) => setDraft((d) => (d?.kind === "create" ? { ...d, about } : d)),
              // Tab: from the name to what the agent should write (a new file only, with a thread).
              tab: link && !draft.folder ? () => setDraft((d) => (d?.kind === "create" ? { ...d, about: d.about ?? "", field: d.field === "name" ? "about" : "name" } : d)) : undefined,
            }
          : {}),
      }
    : null;

  const rootListing = cache.dirs.get("");
  const into = clip ? cursorFolder() : "";
  return (
    <div ref={boxRef} className="relative flex min-h-0 flex-1 flex-col" data-files-tree={threadId}>
      <div className="relative flex shrink-0 items-center gap-1 px-2 pb-2">
        <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg border border-border/70 bg-background px-2 transition-colors duration-[120ms] focus-within:border-ring/70 hover:border-border">
          <UiGlyph name="search" className="size-3.5 text-muted-foreground" />
          <input
            ref={searchRef}
            value={query}
            placeholder="Search files"
            aria-label="Search the folders opened"
            spellCheck={false}
            autoComplete="off"
            data-files-search
            onFocus={() => {
              if (searchOrigin.current === null) searchOrigin.current = cursorPath;
            }}
            onChange={(event) => {
              const value = event.target.value;
              setQuery(value);
              if (searchOrigin.current === null) searchOrigin.current = cursorPath;
              if (!value.trim()) setCursor(searchOrigin.current);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "ArrowDown" || event.key === "Enter") {
                event.preventDefault();
                const hit = firstMatch(rows);
                if (hit) setCursor(hit.path);
                focusList();
              } else if (event.key === "Escape") {
                event.preventDefault();
                if (searching) endSearch(false);
                focusList();
              }
            }}
            className="peer h-full min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
          />
          {query ? (
            // While typing, letters are the search's: Enter hands the keyboard to the results, where every key is the tree's again.
            <span className="hidden shrink-0 items-center gap-1 text-[11px] text-muted-foreground peer-focus:flex" title="Enter or the down arrow: into the results, where j, k, l and the rest work as always" data-files-search-hint>
              <Kbd>↵</Kbd> to the results
            </span>
          ) : null}
          {query ? (
            <button type="button" aria-label="Clear the search" title="Clear the search (Escape)" onClick={() => (endSearch(false), focusList())} className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-state-hover hover:text-foreground">
              <UiGlyph name="close" className="size-3" />
            </button>
          ) : (
            <Kbd>/</Kbd>
          )}
        </label>
        <ToolButton label="New file (A)" glyph="newFile" onClick={() => startCreate(false)} />
        <ToolButton label="New folder (Shift A)" glyph="newFolder" onClick={() => startCreate(true)} />
        <ProgressLine active={refreshing} className="bottom-0" />
      </div>
      {link && (agentView || (agent?.files.length ?? 0) > 0) ? (
        <div className="flex shrink-0 items-center gap-1 px-2 pb-1.5">
          <button
            type="button"
            aria-pressed={agentView}
            onMouseDown={(event) => event.preventDefault()}
            onClick={toggleAgentView}
            title={agentView ? "Back to every file (T)" : "Only the files the agent changed (T)"}
            data-files-agent-chip
            className={cn(
              "inline-flex h-6 items-center gap-1.5 rounded-full border px-2 text-xs transition-colors duration-[120ms] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              agentView ? "border-violet-500/40 bg-violet-500/15 text-violet-700 in-[.dark]:text-violet-300" : "border-border/70 text-muted-foreground hover:bg-state-hover hover:text-foreground",
            )}
          >
            <span className={cn("helix-files-agent-dot text-violet-500 in-[.dark]:text-violet-400", agent?.running && "helix-files-agent-live")} />
            <span className="tabular-nums">{agent?.files.length ?? 0}</span>
            {agent?.running ? "changing now" : "changed by the agent"}
            <Kbd className="ml-0.5 h-4 min-w-4 text-[10px]">T</Kbd>
          </button>
        </div>
      ) : null}
      {/* One list element from the first frame, so the focus the rail gives it stays when the rows arrive. */}
      <TreeRows
        listRef={listRef}
        rows={rows}
        cursor={at}
        focused={focused}
        selected={selected}
        cut={cut}
        status={status}
        changedDirs={changedDirs}
        editing={editing}
        mark={mark}
        arrived={arrived}
        label="Files"
        pointer={pointer}
        onKeyDown={onKeyDown}
        onFocusChange={setFocused}
        scroll={scroll}
        onScrolled={(top) => {
          memory.scroll = top;
          cancelAnimationFrame(scrollFrame.current);
          scrollFrame.current = requestAnimationFrame(() => setScroll(top));
        }}
        onContextMenu={onContextMenu}
        onDragStart={onDragStart}
        onDragEnd={() => draggedRows.set(null)}
        marks={marks}
        draggable={Boolean(link)}
      >
        {rootListing ? null : <SkeletonRows count={9} dense className="absolute inset-x-0 top-1" />}
      </TreeRows>
      {menu ? <RowMenu x={menu.x} y={menu.y} items={menuItems} onClose={closeMenu} /> : null}
      {ask && link ? (
        <AskBox
          targets={ask.targets}
          top={ask.top}
          thread={threadTitle}
          onSend={sendAsk}
          onClose={() => {
            setAsk(null);
            focusList();
          }}
        />
      ) : null}
      <Foot
        notice={notice}
        confirm={confirm}
        clip={clip}
        selected={selected.size}
        selecting={visual}
        into={into}
        onConfirm={() => confirm && void remove(confirm)}
        onCancel={() => {
          setConfirm(null);
          focusList();
        }}
        onDropClip={() => {
          setClip(null);
          focusList();
        }}
        onClearSelection={() => {
          setSelected(EMPTY);
          focusList();
        }}
      />
    </div>
  );
}

function ToolButton({ label, glyph, onClick }: { label: string; glyph: "newFile" | "newFolder"; onClick(): void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors duration-[120ms] hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <UiGlyph name={glyph} />
    </button>
  );
}

/** The foot: the trash question, what waits to be pasted, a selection, or what just happened. Only while there is something. */
function Foot({
  notice,
  confirm,
  clip,
  selected,
  selecting,
  into,
  onConfirm,
  onCancel,
  onDropClip,
  onClearSelection,
}: {
  notice: Notice | null;
  confirm: Confirm | null;
  clip: { mode: "copy" | "move"; paths: string[] } | null;
  selected: number;
  /** A range is being selected (`v`). */
  selecting: boolean;
  into: string;
  onConfirm(): void;
  onCancel(): void;
  onDropClip(): void;
  onClearSelection(): void;
}) {
  if (confirm) return <ConfirmBar confirm={confirm} onConfirm={onConfirm} onCancel={onCancel} />;
  if (!notice && !clip && selected === 0) return null;
  const what = (paths: string[]) => (paths.length === 1 ? nameOf(paths[0]!) : `${paths.length} items`);
  return (
    <div className="flex shrink-0 flex-col border-t border-border/60 text-xs">
      {notice ? (
        <p role={notice.tone === "error" ? "alert" : "status"} className={cn("flex min-h-8 items-center gap-1.5 px-3 py-1.5 leading-5", notice.tone === "error" ? "text-destructive" : "text-muted-foreground")} data-files-notice={notice.tone}>
          {notice.tone === "error" ? <UiGlyph name="warn" className="size-3.5" /> : null}
          <span className="min-w-0 break-words">{notice.text}</span>
        </p>
      ) : null}
      {clip ? (
        <div className="flex h-8 items-center gap-1.5 px-3" data-files-clip={clip.mode}>
          <span className="min-w-0 truncate">
            <span className="font-medium text-foreground">{what(clip.paths)}</span>
            <span className="text-muted-foreground">{clip.mode === "copy" ? " to copy." : " to move."}</span>
          </span>
          <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
            <Kbd>P</Kbd> pastes into <span className="max-w-24 truncate text-foreground">{into ? nameOf(into) : "the workspace"}</span>
          </span>
          <span className="flex-1" />
          <button type="button" aria-label="Drop what waits to be pasted" title="Drop it (Escape)" onClick={onDropClip} className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground">
            <UiGlyph name="close" className="size-3.5" />
          </button>
        </div>
      ) : null}
      {selected > 0 ? (
        <div className="flex h-8 items-center gap-1.5 px-3 text-muted-foreground" data-files-selection>
          <span className="tabular-nums text-foreground">{selected} selected</span>
          {selecting ? (
            <span className="flex min-w-0 items-center gap-1 truncate" data-files-selecting>
              <Kbd>J</Kbd>
              <Kbd>K</Kbd> take more, <Kbd>V</Kbd> stops
            </span>
          ) : null}
          <span className="flex-1" />
          <button type="button" onClick={onClearSelection} className="h-6 rounded-md px-1.5 hover:bg-state-hover hover:text-foreground">
            Clear
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ConfirmBar({ confirm, onConfirm, onCancel }: { confirm: Confirm; onConfirm(): void; onCancel(): void }) {
  const yes = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => yes.current?.focus({ preventScroll: true }), []);
  const one = confirm.paths.length === 1 ? nameOf(confirm.paths[0]!) : null;
  const forGood = confirm.action === "delete";
  const question = forGood ? `Delete ${one ?? `${confirm.paths.length} items`} for good?` : `Move ${one ?? `${confirm.paths.length} items`} to the trash?`;
  return (
    <div
      role="alertdialog"
      aria-label={question}
      data-files-confirm={confirm.action}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
      className={cn("flex shrink-0 flex-col gap-2 border-t px-3 py-2.5 helix-files-arrive", forGood ? "border-destructive/40 bg-destructive/10" : "border-border/60 bg-muted/50")}
    >
      <p className="flex items-start gap-2 text-[13px] leading-5">
        <UiGlyph name="trash" className={cn("mt-0.5 size-4", forGood ? "text-destructive" : "text-muted-foreground")} />
        <span className="min-w-0 break-words">
          <span className="font-medium">{question}</span>
          {forGood ? <span className="block text-xs text-muted-foreground">It does not go to the trash and cannot be undone.</span> : null}
        </span>
      </p>
      <div className="flex justify-end gap-1.5">
        <button type="button" onClick={onCancel} className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          Cancel <Kbd>Esc</Kbd>
        </button>
        <button
          ref={yes}
          type="button"
          onClick={onConfirm}
          data-files-confirm-yes
          className={cn(
            "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
            forGood ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : "bg-foreground text-background hover:bg-foreground/90",
          )}
        >
          {forGood ? "Delete for good" : "Move to trash"} <Kbd className="border-current/30 bg-transparent text-current">↵</Kbd>
        </button>
      </div>
    </div>
  );
}

function nearestStop(rows: readonly Row[], from: number): number {
  for (let d = 0; d < rows.length; d++) {
    if (rows[from + d]?.type === "entry") return from + d;
    if (rows[from - d]?.type === "entry") return from - d;
  }
  return from;
}

function renamePrefix(open: ReadonlySet<string>, from: string, to: string): Set<string> {
  const next = new Set<string>();
  for (const p of open) next.add(p === from || p.startsWith(`${from}/`) ? to + p.slice(from.length) : p);
  return next;
}

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const indexOfPath = (rows: readonly Row[], path: string) => rows.some((r) => r.type === "entry" && r.path === path);
