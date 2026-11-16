// The editor: one file, its changes against HEAD, and its comments in a
// margin rail (wide) or folded under their lines (narrow), with the handoff
// tray at the bottom.
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { experimental_useCodeTheme, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  EmptyState,
  HandoffSheet,
  Kbd,
  SentChip,
  useContainerWidth,
  useHandoff,
  useHotkeys,
  useKitMotion,
} from "../../kit";
import type { Comment, FileRef, RpcContract, Severity } from "../../server/contract";
import { compilePrompt } from "../../server/prompt";
import { useBaseRead, useCommentWrites, useFileComments, useFileRead } from "../data";
import { InlineSlots, type CommentMark } from "../editor/comments";
import { ReviewEditor } from "../editor/ReviewEditor";
import type { CodeTheme } from "../editor/theme";
import { awaitingAck, byPosition, clientCommentId, countByState, needsAttention, sendable, step, trayLabel } from "../model/comments";
import { handoffMetadata } from "../model/comments";
import { docReducer, initialDoc, reconcileDisk } from "../model/doc";
import { layoutRail } from "../model/rail";
import { Banner, EditorSkeleton, FileHeader, SelectionToolbar, type DiffLayout, type ViewMode } from "./Chrome";
import { CommentNote, DraftNote, type NoteActions } from "./CommentNote";
import { SplitDiff } from "./SplitDiff";

const WIDE = 880;
const SPLIT_MIN = 720;
const RAIL_WIDTH = 300;
const DRAFT = "draft";
/** An agent resolution counts as seen after this long on screen. */
const SEEN_AFTER_MS = 1_000;
/** Leaving a file acknowledges after this grace, cancelled by a remount. */
const LEAVE_GRACE_MS = 1_500;
/** Pending "left the file" acknowledgments, by file. */
const leaving = new Map<string, number>();

interface Draft {
  startLine: number;
  endLine: number;
}

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Calls `fn` at most once per animation frame. */
function useFrameThrottle(fn: () => void) {
  const frame = useRef<number | null>(null);
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
  }, []);
  return useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      latest.current();
    });
  }, []);
}

export function EditorPage({
  file,
  threadId,
  projectId,
  lineRange,
}: {
  file: FileRef;
  threadId: string | null;
  projectId: string | null;
  lineRange: { startLineNumber: number; endLineNumber: number } | null | undefined;
}) {
  const read = useFileRead(file);
  const base = useBaseRead(file, read.data?.status === "text");
  const commentsRead = useFileComments(file);
  const writes = useCommentWrites(file);
  const codeTheme = experimental_useCodeTheme();
  const theme = (codeTheme.theme ?? null) as CodeTheme | null;
  const { variants, transition } = useKitMotion();

  const { ref: widthRef, width } = useContainerWidth<HTMLDivElement>();
  const wide = width >= WIDE;
  const splitFits = width >= SPLIT_MIN;

  const [doc, dispatch] = useReducer(docReducer, initialDoc);
  const docRef = useRef(doc);
  docRef.current = doc;
  const [mode, setMode] = useState<ViewMode>("edit");
  const [diffLayout, setDiffLayout] = useState<DiffLayout>("unified");
  const [compare, setCompare] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [replyingId, setReplyingId] = useState<string | null>(null);
  const [folded, setFolded] = useState<string[]>([]);
  const [showResolved, setShowResolved] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [ready, setReady] = useState(false);
  const [geometry, bumpGeometry] = useReducer((n: number) => n + 1, 0);
  const [selection, bumpSelection] = useReducer((n: number) => n + 1, 0);
  const [splitTop, setSplitTop] = useState(1);

  const pageRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<ReviewEditor | null>(null);
  const slots = useMemo(() => new InlineSlots(), []);
  const inlineSlots = useSyncExternalStore(slots.subscribe, slots.getSnapshot);
  const heights = useRef(new Map<string, number>());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const allComments = useMemo(() => [...(commentsRead.data?.comments ?? [])].sort(byPosition), [commentsRead.data]);
  const shown = useMemo(
    () => allComments.filter((comment) => showResolved || needsAttention(comment) || comment.id === activeId),
    [allComments, showResolved, activeId],
  );
  const counts = useMemo(() => countByState(allComments), [allComments]);
  const byAgent = useMemo(() => allComments.filter(awaitingAck), [allComments]);
  const fileText = read.data?.status === "text" ? read.data : null;
  const baseText =
    base.data?.status === "text" ? base.data.content : base.data?.status === "missing" ? "" : null;
  const diffAvailable = baseText !== null;
  const root = fileText ? fileText.absolutePath.slice(0, fileText.absolutePath.length - file.path.length - 1) : null;

  // ----- the editor --------------------------------------------------------

  const onGeometry = useFrameThrottle(bumpGeometry);
  const onSelection = useFrameThrottle(bumpSelection);
  const dirtyTimer = useRef<number | null>(null);
  const handlers = useRef({
    save: () => {},
    comment: () => {},
    walk: (_direction: 1 | -1) => {},
    marker: (_ids: readonly string[]) => {},
  });

  useLayoutEffect(() => {
    if (fileText === null || editorRef.current !== null || hostRef.current === null) return;
    const editor = new ReviewEditor({
      parent: hostRef.current,
      content: fileText.content,
      path: file.path,
      theme,
      base: baseText,
      mode: "edit",
      slots,
      callbacks: {
        onDocChange: () => {
          if (dirtyTimer.current !== null) window.clearTimeout(dirtyTimer.current);
          dirtyTimer.current = window.setTimeout(() => {
            dispatch({ type: "edited", content: editor.getContent() });
          }, 120);
        },
        onSelection,
        onGeometry,
        onSave: () => handlers.current.save(),
        onComment: () => handlers.current.comment(),
        onWalk: (direction) => handlers.current.walk(direction),
        onEscape: () => pageRef.current?.focus({ preventScroll: true }),
        onMarker: (ids) => handlers.current.marker(ids),
      },
    });
    editorRef.current = editor;
    dispatch({ type: "loaded", file: { sha256: fileText.sha256, content: fileText.content } });
    setReady(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileText !== null]);

  useEffect(
    () => () => {
      if (dirtyTimer.current !== null) window.clearTimeout(dirtyTimer.current);
      editorRef.current?.destroy();
      editorRef.current = null;
    },
    [],
  );

  useEffect(() => editorRef.current?.setTheme(theme), [theme, ready]);
  useEffect(() => editorRef.current?.setBase(baseText), [baseText, ready]);
  useEffect(() => {
    editorRef.current?.setMode(mode === "diff" && diffLayout === "unified" && diffAvailable ? "unified" : "edit");
  }, [mode, diffLayout, diffAvailable, ready]);

  // A fresh read of the file: reload in place, or ask when the buffer is dirty.
  useEffect(() => {
    const editor = editorRef.current;
    if (fileText === null || editor === null) return;
    const disk = { sha256: fileText.sha256, content: fileText.content };
    const decision = reconcileDisk(docRef.current, disk);
    if (decision.effect === "replace") {
      editor.replaceContent(disk.content);
      dispatch({ type: "took-disk", file: disk });
    } else if (decision.effect === "ask") {
      dispatch({ type: "external", file: disk });
    }
  }, [fileText?.sha256, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  // Navigation requested by bb (a link to a line range). bb hands a new
  // object for every targeted open, but can also re-render with a fresh copy
  // of the same range; never let that pull the cursor or focus while the
  // user is working inside this page.
  const lastRange = useRef<{ start: number; end: number } | null>(null);
  useEffect(() => {
    if (!lineRange || !ready) return;
    const next = { start: lineRange.startLineNumber, end: lineRange.endLineNumber };
    const same = lastRange.current?.start === next.start && lastRange.current?.end === next.end;
    const working = pageRef.current?.contains(document.activeElement) ?? false;
    if (same && working) return;
    lastRange.current = next;
    // Place the cursor and bring the lines into view; selecting them would
    // raise the Comment toolbar over a note that is already there.
    editorRef.current?.revealLines(next.start, next.end, { select: false, cursor: true, focus: !working });
  }, [lineRange, ready]);

  // ----- saving -------------------------------------------------------------

  const save = useCallback(
    async (expectedSha256?: string | null): Promise<string | null> => {
      const editor = editorRef.current;
      const state = docRef.current;
      if (editor === null || state.base === null || state.saving) return null;
      const content = editor.getContent();
      if (expectedSha256 === undefined && content === state.base.content) return state.base.sha256;
      dispatch({ type: "save-started" });
      try {
        const result = await writes.save.mutate({
          ...file,
          content,
          expectedSha256: expectedSha256 === undefined ? state.base.sha256 : expectedSha256,
        });
        if (result.outcome === "saved") {
          dispatch({ type: "saved", sha256: result.sha256, content, bufferContent: editor.getContent() });
          return result.sha256;
        }
        dispatch({ type: "save-conflict", currentSha256: result.currentSha256 });
        return null;
      } catch (cause) {
        dispatch({ type: "save-failed" });
        toast.error(`Not saved: ${errorMessage(cause)}`);
        return null;
      }
    },
    [file, writes.save],
  );

  // Conflict choices read the disk fresh, never a cached read.
  const rpc = useRpc<RpcContract>();
  const readDisk = useCallback(async () => {
    const latest = await rpc.call("readFile", file);
    if (latest.status !== "text") throw new Error(latest.status === "missing" ? "The file was deleted." : "The file is no longer editable text.");
    return { sha256: latest.sha256, content: latest.content };
  }, [rpc, file]);

  const takeDisk = useCallback(async () => {
    try {
      const disk = await readDisk();
      editorRef.current?.replaceContent(disk.content);
      dispatch({ type: "took-disk", file: disk });
      setCompare(null);
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
  }, [readDisk]);

  const keepMine = useCallback(async () => {
    const editor = editorRef.current;
    if (editor === null) return;
    try {
      const disk = await readDisk();
      dispatch({ type: "kept-mine", file: disk, bufferContent: editor.getContent() });
      setCompare(null);
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
  }, [readDisk]);

  // Leaving the file acknowledges the agent resolutions the reviewer saw (on
  // screen for a second). The host can unmount and remount a tab on open, so
  // leaving waits a moment and a remount of the same file cancels it.
  const fileKey = `${file.environmentId}\u0000${file.path}`;
  const seen = useRef(new Set<string>());
  const byAgentKey = byAgent.map((comment) => comment.id).join(",");
  useEffect(() => {
    if (byAgentKey === "") return;
    const ids = byAgentKey.split(",");
    const timer = window.setTimeout(() => ids.forEach((id) => seen.current.add(id)), SEEN_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [byAgentKey]);
  useEffect(() => {
    const pending = leaving.get(fileKey);
    if (pending !== undefined) {
      window.clearTimeout(pending);
      leaving.delete(fileKey);
    }
    const seenNow = seen.current;
    return () => {
      const ids = [...seenNow];
      if (ids.length === 0) return;
      leaving.set(
        fileKey,
        window.setTimeout(() => {
          leaving.delete(fileKey);
          void rpc.call("acknowledgeComments", { ids }).catch(() => undefined);
        }, LEAVE_GRACE_MS),
      );
    };
  }, [rpc, fileKey]);

  // ----- comments -----------------------------------------------------------

  /** Bring keyboard focus to the page (not the editor) so single-key shortcuts work. */
  const focusPage = useCallback(() => {
    const active = document.activeElement;
    const page = pageRef.current;
    if (page === null) return;
    if (active instanceof HTMLElement && page.contains(active) && (active.isContentEditable || active.tagName === "TEXTAREA")) return;
    page.focus({ preventScroll: true });
  }, []);

  const activate = useCallback(
    (comment: Comment, options: { reveal?: boolean; focusEditor?: boolean } = {}) => {
      setActiveId(comment.id);
      if (!options.focusEditor) focusPage();
      setReplyingId(null);
      if (!wide) setFolded((ids) => (ids.includes(comment.id) ? ids : [...ids, comment.id]));
      if (options.reveal !== false && comment.state !== "outdated") {
        editorRef.current?.revealLines(comment.startLine, comment.endLine, { select: false, focus: options.focusEditor });
      }
    },
    [wide, focusPage],
  );

  const startDraft = useCallback(() => {
    const editor = editorRef.current;
    if (editor === null || fileText === null) return;
    const { startLine, endLine } = editor.selectedLines();
    setDraft({ startLine, endLine });
    setActiveId(null);
    setReplyingId(null);
    editor.revealLines(startLine, endLine, { select: false });
  }, [fileText]);

  const submitDraft = useCallback(
    async (body: string, severity: Severity) => {
      const current = draft;
      const state = docRef.current;
      if (current === null || state.base === null) return;
      let sha = state.base.sha256;
      if (state.dirty) {
        const saved = await save();
        if (saved === null) throw new Error("Save the file before commenting: it changed on disk.");
        sha = saved;
      }
      const id = clientCommentId();
      setDraft(null);
      setActiveId(id);
      await writes.create.mutate({
        id,
        ...file,
        startLine: current.startLine,
        endLine: current.endLine,
        body,
        severity,
        threadId,
        fileSha256: sha,
      });
    },
    [draft, file, save, threadId, writes.create],
  );

  const actionsFor = useCallback(
    (comment: Comment): NoteActions => ({
      onActivate: () => activate(comment, { reveal: true }),
      onReply: (body) => writes.reply.mutate({ commentId: comment.id, body }),
      onResolve: () => {
        writes.setState.mutate({ id: comment.id, state: "resolved" }).catch((cause) => toast.error(errorMessage(cause)));
      },
      onReopen: () => {
        writes.setState.mutate({ id: comment.id, state: "open" }).catch((cause) => toast.error(errorMessage(cause)));
      },
      onAcknowledge: () => {
        writes.acknowledge.mutate({ ids: [comment.id] }).catch((cause) => toast.error(errorMessage(cause)));
      },
      onDelete: () => {
        setActiveId(null);
        writes.remove.mutate({ id: comment.id }).catch((cause) => toast.error(errorMessage(cause)));
      },
      onEdit: (patch) => writes.update.mutate({ id: comment.id, ...patch }),
    }),
    [activate, writes],
  );

  const walk = useCallback(
    (direction: 1 | -1) => {
      const next = step(shown, { activeId, line: editorRef.current?.cursorLine() ?? 1 }, direction);
      if (next !== null) activate(next);
    },
    [shown, activeId, activate],
  );

  handlers.current = {
    save: () => void save(),
    comment: startDraft,
    walk,
    marker: (ids) => {
      const comment = allComments.find((candidate) => candidate.id === ids[0]);
      if (comment === undefined) return;
      if (!wide && folded.includes(comment.id) && activeId === comment.id) {
        setFolded((list) => list.filter((id) => !ids.includes(id)));
        setActiveId(null);
        return;
      }
      if (!wide) setFolded((list) => [...new Set([...list, ...ids])]);
      activate(comment, { reveal: false });
    },
  };

  // Tell CodeMirror what to mark and which notes render in place.
  useEffect(() => {
    const editor = editorRef.current;
    if (editor === null) return;
    const marks: CommentMark[] = shown.map((comment) => ({
      id: comment.id,
      startLine: comment.startLine,
      endLine: comment.endLine,
      severity: comment.severity,
      outdated: comment.state === "outdated",
      resolved: comment.state === "resolved" && !awaitingAck(comment),
    }));
    if (draft !== null) {
      marks.push({ id: DRAFT, startLine: draft.startLine, endLine: draft.endLine, severity: "note", outdated: false, resolved: false });
    }
    const inline = wide
      ? []
      : [...folded.filter((id) => shown.some((comment) => comment.id === id && comment.state !== "outdated")), ...(draft === null ? [] : [DRAFT])];
    editor.setComments({ marks, activeId: draft === null ? activeId : DRAFT, inline });
  }, [shown, activeId, draft, folded, wide, ready]);

  // Folded notes size themselves to the visible code width (see editor.css).
  useLayoutEffect(() => {
    const page = pageRef.current;
    const scroller = scrollRef.current;
    const gutters = hostRef.current?.querySelector<HTMLElement>(".cm-gutters");
    if (page === null || scroller === null) return;
    page.style.setProperty("--rv-view-width", `${scroller.clientWidth}px`);
    if (gutters) page.style.setProperty("--rv-gutter-width", `${gutters.offsetWidth}px`);
  }, [geometry, width, ready]);

  // ----- the margin rail (wide) ---------------------------------------------

  const railItems = useMemo(() => {
    const editor = editorRef.current;
    const rail = railRef.current;
    if (!wide || editor === null || rail === null) return [];
    void geometry;
    const items = shown.map((comment) => ({
      id: comment.id,
      anchor: editor.lineTop(comment.startLine, rail),
      height: heights.current.get(comment.id) ?? 96,
    }));
    if (draft !== null) {
      items.push({ id: DRAFT, anchor: editor.lineTop(draft.startLine, rail), height: heights.current.get(DRAFT) ?? 160 });
    }
    return items;
  }, [shown, draft, geometry, wide, ready, mode, diffLayout]);
  const railTops = useMemo(
    () => layoutRail(railItems, draft !== null ? DRAFT : activeId),
    [railItems, draft, activeId],
  );

  // One observer for every note's height; stable ref callbacks per id.
  const handoffRef = useRef<{ itemRef: (key: string) => (element: HTMLElement | null) => void } | null>(null);
  const resize = useMemo(
    () =>
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver((entries) => {
            let changed = false;
            for (const entry of entries) {
              const element = entry.target as HTMLElement;
              const id = element.dataset.commentId;
              if (id === undefined) continue;
              const height = element.offsetHeight;
              if (heights.current.get(id) !== height) {
                heights.current.set(id, height);
                changed = true;
              }
            }
            if (changed) bumpGeometry();
          }),
    [],
  );
  useEffect(() => () => resize?.disconnect(), [resize]);
  const observed = useRef(new Map<string, HTMLElement>());
  const refs = useRef(new Map<string, (element: HTMLElement | null) => void>());
  const noteRef = useCallback(
    (id: string) => {
      let callback = refs.current.get(id);
      if (callback === undefined) {
        callback = (element: HTMLElement | null) => {
          const previous = observed.current.get(id);
          if (previous !== undefined && previous !== element) resize?.unobserve(previous);
          if (element === null) observed.current.delete(id);
          else {
            observed.current.set(id, element);
            resize?.observe(element);
          }
          if (id !== DRAFT) handoffRef.current?.itemRef(id)(element);
        };
        refs.current.set(id, callback);
      }
      return callback;
    },
    [resize],
  );

  // ----- the selection toolbar ---------------------------------------------

  const toolbar = useMemo(() => {
    void selection;
    void geometry;
    const editor = editorRef.current;
    const scroller = scrollRef.current;
    if (editor === null || scroller === null || draft !== null || !editor.hasFocus()) return null;
    const coords = editor.selectionCoords();
    if (coords === null) return null;
    const box = scroller.getBoundingClientRect();
    return {
      left: Math.min(Math.max(coords.left - box.left + scroller.scrollLeft, 56), box.width - 180),
      top: coords.bottom - box.top + scroller.scrollTop + 6,
    };
  }, [selection, geometry, draft]);

  // ----- the handoff ---------------------------------------------------------

  const toSend = useMemo(() => sendable(allComments), [allComments]);
  const fileName = file.path.slice(file.path.lastIndexOf("/") + 1);
  const handoff = useHandoff<Comment>({
    items: toSend,
    getKey: (comment) => comment.id,
    buildPrompt: (items) => compilePrompt(items, [{ environmentId: file.environmentId, root, branch: null }]),
    pluginMetadata: (items) => handoffMetadata(items, file.environmentId, Date.now()),
    noun: { one: "comment", many: "comments" },
    currentThreadId: threadId,
    projectId,
    newThreadTitle: (items) => `Review ${fileName}: ${items.length} ${items.length === 1 ? "comment" : "comments"}`,
    onSent: async (result, items) => {
      await writes.markSent.mutate({ commentIds: items.map((comment) => comment.id), threadId: result.threadId });
    },
    hotkey: "s",
  });
  handoffRef.current = handoff;

  // ----- keyboard ------------------------------------------------------------

  const active = allComments.find((comment) => comment.id === activeId) ?? null;
  useHotkeys(
    [
      { key: "c", handler: startDraft, description: "Comment on the selected lines", group: "Comments" },
      { key: "]", handler: () => walk(1), description: "Next comment", group: "Comments" },
      { key: "[", handler: () => walk(-1), description: "Previous comment", group: "Comments" },
      {
        key: "r",
        handler: () => active && setReplyingId(active.id),
        description: "Reply to the comment",
        group: "Comments",
        enabled: active !== null,
      },
      {
        key: "x",
        handler: () => {
          if (active === null) return;
          const actions = actionsFor(active);
          if (awaitingAck(active)) actions.onAcknowledge();
          else if (active.state === "resolved") actions.onReopen();
          else actions.onResolve();
        },
        description: "Mark resolved, acknowledge, or reopen",
        group: "Comments",
        enabled: active !== null,
      },
      { key: "h", handler: () => setShowResolved((value) => !value), description: "Show or hide resolved comments", group: "Comments" },
      { key: "e", handler: () => setMode("edit"), description: "Edit", group: "View" },
      { key: "d", handler: () => diffAvailable && setMode("diff"), description: "Diff against HEAD", group: "View", enabled: diffAvailable },
      {
        key: "u",
        handler: () => setDiffLayout((layout) => (layout === "unified" && splitFits ? "split" : "unified")),
        description: "Unified or split diff",
        group: "View",
        enabled: mode === "diff",
      },
      {
        key: "Enter",
        handler: () => {
          if (active !== null && active.state !== "outdated") {
            editorRef.current?.revealLines(active.startLine, active.endLine, { focus: true });
          } else editorRef.current?.focus();
        },
        description: "Go to the code",
        group: "View",
      },
      {
        key: "mod+s",
        handler: () => void save(),
        description: "Save",
        group: "File",
        allowInInputs: true,
      },
      {
        key: "Escape",
        handler: () => {
          if (draft !== null) setDraft(null);
          else if (replyingId !== null) setReplyingId(null);
          else setActiveId(null);
        },
      },
    ],
    { scope: pageRef },
  );

  // ----- render --------------------------------------------------------------

  const setPage = useCallback(
    (element: HTMLDivElement | null) => {
      pageRef.current = element;
      widthRef(element);
    },
    [widthRef],
  );

  const showSplit = (mode === "diff" && diffLayout === "split" && splitFits && diffAvailable) || compare !== null;
  useEffect(() => {
    if (showSplit) setSplitTop(editorRef.current?.topLine() ?? 1);
  }, [showSplit]);

  const noteFor = (comment: Comment, extra?: string) => (
    <CommentNote
      comment={comment}
      active={comment.id === activeId}
      now={now}
      replying={replyingId === comment.id}
      setReplying={(replying) => setReplyingId(replying ? comment.id : null)}
      actions={actionsFor(comment)}
      className={extra}
      ref={noteRef(comment.id)}
    />
  );

  if (read.error !== null && read.data === undefined) {
    return (
      <EmptyState
        tone="error"
        icon="AlertCircle"
        title={`Could not open ${fileName}`}
        description={read.error.message}
        action={
          <Button size="sm" variant="outline" onClick={() => void read.refetch()}>
            Try again
          </Button>
        }
      />
    );
  }
  if (read.data?.status === "missing") {
    return (
      <EmptyState
        icon="AlertCircle"
        title={`${fileName} no longer exists`}
        description="It was deleted or moved. Its comments stay in the thread's Review tab."
      />
    );
  }

  const outdated = shown.filter((comment) => comment.state === "outdated");

  return (
    <div
      ref={setPage}
      tabIndex={-1}
      className="rv-editor flex h-full min-h-0 flex-col bg-background text-foreground outline-none @container"
    >
      <FileHeader
        path={file.path}
        dirty={doc.dirty}
        saving={doc.saving}
        mode={mode}
        onMode={setMode}
        diffAvailable={diffAvailable}
        diffLayout={diffLayout}
        onDiffLayout={setDiffLayout}
        splitFits={splitFits}
        refreshing={(read.isFetching || commentsRead.isFetching) && ready}
        onSave={() => void save()}
        compact={!wide}
      />

      <AnimatePresence initial={false}>
        {doc.conflict !== null ? (
          <Banner
            key="conflict"
            tone="warning"
            actions={
              <>
                <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setCompare(read.data?.status === "text" ? read.data.content : "")}>
                  Compare
                </Button>
                <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => void takeDisk()}>
                  Use the version on disk
                </Button>
                <Button size="sm" variant="outline" className="h-7 px-2" onClick={() => void save(doc.conflict?.currentSha256 ?? null)}>
                  Save mine anyway
                </Button>
              </>
            }
          >
            Not saved: {doc.conflict.currentSha256 === null ? "the file was deleted" : "the file changed on disk"} since you opened it.
          </Banner>
        ) : doc.external !== null ? (
          <Banner
            key="external"
            actions={
              <>
                <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setCompare(doc.external?.content ?? "")}>
                  Compare
                </Button>
                <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => void takeDisk()}>
                  Reload
                </Button>
                <Button size="sm" variant="outline" className="h-7 px-2" onClick={() => void keepMine()}>
                  Keep mine
                </Button>
              </>
            }
          >
            This file changed on disk while you were editing it.
          </Banner>
        ) : null}
      </AnimatePresence>

      <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-auto overscroll-contain">
        {!ready ? <EditorSkeleton /> : null}
        {showSplit && fileText !== null ? (
          <SplitDiff
            original={compare ?? baseText ?? ""}
            content={editorRef.current?.getContent() ?? fileText.content}
            path={file.path}
            theme={theme}
            labels={compare !== null ? ["On disk", "Yours"] : ["HEAD", "Working copy"]}
            topLine={splitTop}
          />
        ) : null}
        <div
          className={showSplit ? "hidden" : "grid min-h-full"}
          style={{ gridTemplateColumns: wide ? `minmax(0,1fr) ${RAIL_WIDTH}px` : "minmax(0,1fr)" }}
        >
          <div ref={hostRef} className="min-w-0" />
          {wide ? (
            <div ref={railRef} className="relative border-l border-border/40 px-3" aria-label="Comments">
              <svg className="pointer-events-none absolute inset-y-0 -left-px w-3 overflow-visible" aria-hidden>
                {railItems.map((item) => {
                  const top = railTops.get(item.id) ?? item.anchor;
                  if (Math.abs(top - item.anchor) < 2) return null;
                  const isActive = item.id === activeId || item.id === DRAFT;
                  return (
                    <path
                      key={item.id}
                      d={`M0 ${item.anchor + 10} C 6 ${item.anchor + 10}, 6 ${top + 14}, 12 ${top + 14}`}
                      className={isActive ? "stroke-foreground/50" : "stroke-border"}
                      fill="none"
                      strokeWidth={1}
                    />
                  );
                })}
              </svg>
              <AnimatePresence initial={false}>
                {draft !== null ? (
                  <motion.div
                    key={DRAFT}
                    className="absolute inset-x-3"
                    initial={{ opacity: 0, y: railTops.get(DRAFT) ?? 0, scale: 0.98 }}
                    animate={{ opacity: 1, y: railTops.get(DRAFT) ?? 0, scale: 1 }}
                    exit={{ opacity: 0, transition: transition("exit") }}
                    transition={transition("shift")}
                  >
                    <DraftNote
                      ref={noteRef(DRAFT)}
                      startLine={draft.startLine}
                      endLine={draft.endLine}
                      onSubmit={submitDraft}
                      onCancel={() => setDraft(null)}
                    />
                  </motion.div>
                ) : null}
                {shown.map((comment) => (
                  <motion.div
                    key={comment.id}
                    className="absolute inset-x-3"
                    initial={{ opacity: 0, y: railTops.get(comment.id) ?? 0 }}
                    animate={{ opacity: 1, y: railTops.get(comment.id) ?? 0 }}
                    exit={{ opacity: 0, transition: transition("exit") }}
                    transition={transition("shift")}
                  >
                    {noteFor(comment)}
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          ) : null}
        </div>
        {!showSplit && ready ? <SelectionToolbar position={toolbar} onComment={startDraft} /> : null}
      </div>

      {/* Narrow: open notes render in place under their lines. */}
      {[...inlineSlots.entries()].map(([id, element]) => {
        if (id === DRAFT && draft !== null) {
          return createPortal(
            <motion.div variants={variants.fadeScale} initial="hidden" animate="visible" transition={transition("enter")}>
              <DraftNote startLine={draft.startLine} endLine={draft.endLine} onSubmit={submitDraft} onCancel={() => setDraft(null)} />
            </motion.div>,
            element,
            id,
          );
        }
        const comment = shown.find((candidate) => candidate.id === id);
        return comment === undefined ? null : createPortal(noteFor(comment), element, id);
      })}

      {/* Narrow: outdated comments have no line to fold under. */}
      {!wide && outdated.length > 0 ? (
        <section className="max-h-56 shrink-0 space-y-2 overflow-auto border-t border-border/60 px-3 py-2">
          <p className="text-xs text-muted-foreground">Outdated: their code changed</p>
          {outdated.map((comment) => (
            <div key={comment.id}>{noteFor(comment)}</div>
          ))}
        </section>
      ) : null}

      <footer className="flex h-11 shrink-0 items-center gap-2 border-t border-border/60 px-3">
        <span className="min-w-0 truncate whitespace-nowrap text-xs text-muted-foreground tabular-nums">{trayLabel(counts.open + counts.outdated + counts.sent, toSend.length, byAgent.length, !wide)}</span>
        {shown.length > 0 ? (
          <span className="flex items-center">
            <Button variant="ghost" size="sm" className="h-7 px-1.5" onClick={() => walk(-1)} aria-label="Previous comment">
              <Kbd>[</Kbd>
            </Button>
            <Button variant="ghost" size="sm" className="h-7 px-1.5" onClick={() => walk(1)} aria-label="Next comment">
              <Kbd>]</Kbd>
            </Button>
          </span>
        ) : null}
        {wide && counts.resolved - byAgent.length > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
            aria-pressed={showResolved}
            onClick={() => setShowResolved((value) => !value)}
          >
            {showResolved ? "Hide" : "Show"} {counts.resolved - byAgent.length} resolved <Kbd>H</Kbd>
          </Button>
        ) : null}
        <span className="flex-1" />
        <SentChip result={handoff.lastResult} className={wide ? undefined : "max-w-32"} />
        <HandoffSheet handoff={handoff} />
      </footer>
    </div>
  );
}
