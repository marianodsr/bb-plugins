// The editor surface: the thread's Helix terminal session, attached over its
// own stream and drawn by Ghostty's core. It owns the keyboard while focused
// (app/terminal/keys.ts). Several surfaces may show the same session (the
// editor page and the thread's Helix tab); only the focused one sends resize,
// so they never fight over the size.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { experimental_copyToClipboard as copyToClipboard, experimental_usePluginId as usePluginId, useRealtime, useSdk, useSettings } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { EmptyState, Skeleton } from "../../kit";
import { useGhostty, useHelixRpc, useSetup } from "../data";
import { HudMeter, type HudSnapshot } from "../terminal/hud";
import { installKeyLayer, printable, type OptionAsAlt } from "../terminal/keys";
import { createRenderer, type RendererDiagnostics, type SurfaceFont, type TerminalRenderer } from "../terminal/renderer";
import { TerminalStream, exitOutcome } from "../terminal/stream";
import { editorFocus as editorFocusers, railFocus, railHasFocus, railSheet, railTab, sidebarRailVisible } from "../rail/railStore";
import { CommentBox, type CommentRequest } from "./CommentBox";
import { TreePane, type TreeHandle } from "./TreePane";

/** Pane controls of the visible surfaces, by thread, for the app's commands. */
export const surfaceControls = new Map<string, { toggleTree(): void; switchFocus(): void }>();

const TREE_MIN = 160;
const TREE_MAX = 640;
/** Narrower surfaces start with the tree hidden. */
const TREE_DEFAULT_MIN_SURFACE = 960;

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // not remembered
  }
}

/** The last few KB a session printed, for the exit report. */
class OutputTail {
  private chunks: Uint8Array[] = [];
  private size = 0;
  push(bytes: Uint8Array): void {
    this.chunks.push(bytes);
    this.size += bytes.length;
    while (this.size > 16_384 && this.chunks.length > 1) this.size -= this.chunks.shift()!.length;
  }
  text(): string {
    return new TextDecoder().decode(concat(this.chunks));
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** The last lines a terminal printed, without escape sequences. */
export function lastLines(text: string, count = 12): string {
  // eslint-disable-next-line no-control-regex
  const plain = text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-_]|\r/gu, "");
  return plain
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l, i, all) => l.length > 0 || i < all.length - 1)
    .slice(-count)
    .join("\n")
    .trim();
}

const WASM_URL = "/api/v1/plugins/helix-bridge/http/wterm-ghostty.wasm";

/**
 * When each step of opening the editor happened, in ms since the surface
 * mounted, per thread: session (the terminal id), renderer (font and WebGL
 * ready), attached (the stream is open), firstOutput, firstFrame. Drivers
 * read `window.__helixTimeline`.
 */
type Timeline = Record<string, number>;
function timeline(threadId: string): { mark(step: string): void; reset(): void } {
  const all = ((window as unknown as { __helixTimeline?: Record<string, Timeline> }).__helixTimeline ??= {});
  let start = performance.now();
  return {
    mark: (step) => {
      const t = (all[threadId] ??= {});
      if (t[step] === undefined) t[step] = Math.round(performance.now() - start);
    },
    reset: () => {
      start = performance.now();
      all[threadId] = {};
    },
  };
}

/** How long a surface stays attached to its session after its page left. */
const POOL_IDLE_MS = 10 * 60_000;
/** Quiet time after the last resize step before Helix is told its new size. */
const RESIZE_SETTLE_MS = 90;

interface SurfaceConfig {
  fontFamily: string | null;
  fontSize: number | null;
  fontStyle: string | null;
  faces?: SurfaceFont["faces"];
  boldIsBright: boolean | null;
  background: string | null;
  foreground: string | null;
  hud: boolean;
}

/** The mounted page a pooled surface reports to. */
interface SurfaceOwner {
  mark(step: string): void;
  option(): OptionAsAlt;
  owns(): boolean;
  state(next: "connecting" | "open" | "closed"): void;
  grid(cols: number, rows: number): void;
  ended(outcome: "close" | "report", session: { exitCode: number | null }, screen: Promise<string>): void;
}

/**
 * A Helix surface (renderer and session stream) that outlives its page:
 * leaving the editor detaches it, coming back attaches the same element, so a
 * warm visit shows Helix at once with no reconnect. One owner at a time.
 */
interface PooledSurface {
  container: HTMLDivElement;
  stream: TerminalStream;
  renderer: TerminalRenderer | null;
  ready: Promise<TerminalRenderer>;
  meter: HudMeter | null;
  owner: SurfaceOwner | null;
  ended: boolean;
  timer: number | null;
  dispose(): void;
}

const surfacePool = new Map<string, PooledSurface>();

function surfaceKey(terminalId: string, config: SurfaceConfig): string {
  return JSON.stringify([terminalId, config.fontFamily, config.fontSize, config.fontStyle, config.faces ?? null, config.boldIsBright, config.background, config.foreground, config.hud]);
}

function createSurface(key: string, terminalId: string, config: SurfaceConfig, sdk: ReturnType<typeof useSdk>): PooledSurface {
  void key;
  const container = document.createElement("div");
  container.className = "helix-surface h-full w-full";
  const tail = new OutputTail();
  const meter = config.hud ? new HudMeter() : null;
  let disposed = false;
  let removeKeys: (() => void) | null = null;
  // Output that arrives before the renderer is ready (the stream connects at
  // once, in parallel with the font and WebGL), written when it is.
  let early: Uint8Array[] | null = [];
  let resizeTimer = 0;
  const entry: PooledSurface = {
    container,
    stream: null as unknown as TerminalStream,
    renderer: null,
    ready: null as unknown as Promise<TerminalRenderer>,
    meter,
    owner: null,
    ended: false,
    timer: null,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (entry.timer) window.clearTimeout(entry.timer);
      removeKeys?.();
      entry.stream.close();
      entry.renderer?.dispose();
      container.remove();
    },
  };
  entry.stream = new TerminalStream(terminalId, {
    onChunk: (chunk) => {
      tail.push(chunk.bytes);
      if (!entry.renderer) {
        early?.push(chunk.bytes);
        return;
      }
      entry.owner?.mark("firstOutput");
      requestAnimationFrame(() => entry.owner?.mark("firstFrame"));
      entry.renderer.write(chunk.bytes);
      meter?.output();
    },
    onState: (next) => {
      if (!disposed) entry.owner?.state(next);
    },
    // The stream says at once when the process ends (also on attach, when
    // it ended while no surface was open).
    onSession: (session) => {
      if (disposed || entry.ended) return;
      // bb reports exit code 0 for a process killed by a signal; a Rust panic
      // left on screen still means a crash.
      const outcome = exitOutcome(session) === "close" && /panicked at /u.test(tail.text()) ? "report" : exitOutcome(session);
      if (!outcome) return;
      entry.ended = true;
      entry.stream.close();
      // What is left on the terminal's screen once Helix has left its
      // alternate screen: a panic message lands there. Raw output is screen
      // painting, not lines, so it is only the fallback.
      const screen = (entry.renderer ? entry.renderer.term.readText().catch(() => "") : Promise.resolve("")).then((text) => lastLines(text || tail.text()));
      void screen.then(() => sdk.terminals.close({ terminalId, mode: "force" }).catch(() => {}));
      if (entry.owner) entry.owner.ended(outcome, session, screen);
      else entry.dispose();
    },
  });
  entry.ready = createRenderer(container, {
    wasmUrl: WASM_URL,
    font: { family: config.fontFamily, size: config.fontSize ?? 13, style: config.fontStyle, faces: config.faces },
    boldIsBright: config.boldIsBright === true,
    background: config.background,
    foreground: config.foreground,
    onInput: (data) => {
      entry.stream.input(data);
      if (meter && typeof data === "string") meter.sent(printable(data));
    },
    // While a divider or the window is being dragged the surface follows at
    // once; Helix gets the size once it settles, so it reflows one time.
    onResize: (cols, rows) => {
      entry.owner?.grid(cols, rows);
      if (!entry.owner?.owns()) return;
      if (resizeTimer) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        resizeTimer = 0;
        if (entry.owner?.owns()) entry.stream.resize(cols, rows);
      }, RESIZE_SETTLE_MS);
    },
    onClipboardWrite: (text) => void copyToClipboard({ text }),
  }).then((created) => {
    if (disposed) {
      created.dispose();
      throw new Error("disposed");
    }
    entry.renderer = created;
    if (early && early.length > 0) {
      entry.owner?.mark("firstOutput");
      for (const bytes of early) created.write(bytes);
      requestAnimationFrame(() => entry.owner?.mark("firstFrame"));
    }
    early = null;
    removeKeys = installKeyLayer(container, {
      optionAsAlt: () => entry.owner?.option() ?? "false",
      kittyFlags: () => created.kittyFlags(),
      selection: () => created.selection(),
      copy: (text) => void copyToClipboard({ text }),
      send: (data) => {
        entry.stream.input(data);
        meter?.sent(printable(data));
      },
      observe: (key) => meter?.key(key),
    });
    return created;
  });
  entry.stream.connect();
  // A failed start is reported by the owner; nothing else waits on it.
  entry.ready.catch(() => {});
  return entry;
}

/** Visible surfaces by thread, so a draft's arrival can fly from the editor. */
export const visibleSurfaces = new Map<string, HTMLElement>();

export interface EditorSurfaceProps {
  threadId: string;
  active: boolean;
  autoFocus?: boolean;
  className?: string;
  /** Show the file tree pane (the editor page; not the thread's quick-look tab). */
  tree?: boolean;
  /**
   * Helix exited cleanly or bb closed its terminal: the session is already
   * closed; the caller takes the surface away (back to the thread, or close
   * the tab).
   */
  onClosed(): void;
}

export function EditorSurface({ threadId, active, autoFocus, className, tree, onClosed }: EditorSurfaceProps) {
  const setup = useSetup();
  const ghostty = useGhostty();
  const binaryMissing = setup.data?.checks.find((c) => c.id === "binary" && c.level === "error") ?? null;

  if (setup.loading && !setup.data) return <SurfaceSkeleton className={className} />;
  if (binaryMissing) return <SetupState check={binaryMissing} onRetry={setup.refetch} className={className} />;
  if (!ghostty.data) {
    if (ghostty.error) return <SurfaceError message={`Could not read the editor settings: ${ghostty.error}`} onRetry={ghostty.refetch} className={className} />;
    return <SurfaceSkeleton className={className} />;
  }
  return <Session threadId={threadId} active={active} autoFocus={autoFocus ?? false} tree={tree ?? false} config={ghostty.data} className={className} onClosed={onClosed} />;
}

function Session({
  threadId,
  active,
  autoFocus,
  tree,
  config,
  className,
  onClosed,
}: {
  onClosed(): void;
  threadId: string;
  active: boolean;
  autoFocus: boolean;
  tree: boolean;
  config: { fontFamily: string | null; fontSize: number | null; fontStyle: string | null; faces?: SurfaceFont["faces"]; boldIsBright: boolean | null; optionAsAlt: OptionAsAlt; hud: boolean; background: string | null; foreground: string | null };
  className?: string;
}) {
  const rpc = useHelixRpc();
  const sdk = useSdk();
  const host = useRef<HTMLDivElement>(null);
  const [terminalId, setTerminalId] = useState<string | null>(null);
  const [state, setState] = useState<"starting" | "connecting" | "open" | "closed" | "exited" | "failed">("starting");
  const [failure, setFailure] = useState<string | null>(null);
  const [exit, setExit] = useState<{ code: number | null; lastLines: string } | null>(null);
  const onClosedRef = useRef(onClosed);
  onClosedRef.current = onClosed;
  const closeTreeRef = useRef<() => void>(() => {});
  const { values: settingValues } = useSettings();
  const treeStaysOpen = settingValues?.treeStaysOpen === true;
  /** A path `:bb-files` asked for while the tree was hidden: revealed once it is up. */
  const pendingReveal = useRef<string | null>(null);
  const [hud, setHud] = useState<HudSnapshot | null>(null);
  const [diagnostics, setDiagnostics] = useState<RendererDiagnostics | null>(null);
  const [grid, setGrid] = useState<{ cols: number; rows: number } | null>(null);
  const [commentRequest, setCommentRequest] = useState<CommentRequest | null>(null);
  const [restart, setRestart] = useState(0);
  const marks = useRef(timeline(threadId));
  const activeRef = useRef(active);
  activeRef.current = active;
  const optionRef = useRef<OptionAsAlt>(config.optionAsAlt);
  optionRef.current = config.optionAsAlt;
  const pluginId = usePluginId();
  const surface = useRef<HTMLDivElement>(null);
  const treeHandle = useRef<TreeHandle | null>(null);
  const editorFocus = useRef<(() => void) | null>(null);
  const visibleKey = `${pluginId}.tree.visible`;
  const widthKey = `${pluginId}.tree.width`;
  const [treeOpen, setTreeOpen] = useState<boolean | null>(() => {
    const stored = readStored(visibleKey);
    return stored === null ? null : stored === "1";
  });
  const [treeWidth, setTreeWidth] = useState(() => Math.min(TREE_MAX, Math.max(TREE_MIN, Number(readStored(widthKey)) || 260)));
  // Not chosen yet in this browser: shown on wide surfaces only.
  useLayoutEffect(() => {
    if (treeOpen !== null || !tree) return;
    setTreeOpen((surface.current?.clientWidth ?? 0) >= TREE_DEFAULT_MIN_SURFACE);
  }, [tree, treeOpen]);
  const showTree = tree && treeOpen === true;
  const setTreeVisible = (visible: boolean) => {
    setTreeOpen(visible);
    writeStored(visibleKey, visible ? "1" : "0");
    if (!visible) editorFocus.current?.();
  };
  closeTreeRef.current = () => void rpc.call("treeClose", { threadId }).catch(() => {});

  // The thread's terminal session, started on first use.
  useEffect(() => {
    let cancelled = false;
    setState("starting");
    marks.current.reset();
    rpc.call("editorTerminal", { threadId }).then(
      ({ terminalId: id }) => {
        marks.current.mark("session");
        if (!cancelled) setTerminalId(id);
      },
      (error: unknown) => {
        if (cancelled) return;
        setFailure(error instanceof Error ? error.message : String(error));
        setState("failed");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, threadId, restart]);

  useEffect(() => {
    const element = host.current;
    if (!element || !terminalId) return;
    let detached = false;
    // The editor owns its size while focus is anywhere in this surface (the
    // tree beside it changes its width); another surface showing the same
    // session (the thread's tab) never fights it.
    // With the rail in bb's sidebar, focus is often in the rail: the page's
    // editor owns its size unless another Helix surface has the focus.
    const owns = () => {
      if (!activeRef.current) return false;
      const focused = document.activeElement?.closest("[data-helix-surface]") ?? null;
      return focused === null || focused === surface.current;
    };
    const owner: SurfaceOwner = {
      mark: (step) => marks.current.mark(step),
      option: () => optionRef.current,
      owns,
      state: (next) => {
        if (next === "open") marks.current.mark("attached");
        if (next !== "closed") setState((current) => (current === "exited" ? current : next));
      },
      grid: (cols, rows) => {
        element.dataset.cols = String(cols);
        setGrid({ cols, rows });
        window.dispatchEvent(new CustomEvent("helix-bridge:grid", { detail: { threadId, cols, rows } }));
      },
      ended: (outcome, session, screen) => {
        // The tree goes with the editor.
        closeTreeRef.current();
        if (outcome === "close") {
          onClosedRef.current();
          return;
        }
        setState("exited");
        void screen.then((text) => setExit({ code: session.exitCode, lastLines: text }));
      },
    };
    // Back on this thread: the editor as it was, already attached. A session
    // another surface shows right now gets a surface of its own.
    const config_ = { fontFamily: config.fontFamily, fontSize: config.fontSize, fontStyle: config.fontStyle, faces: config.faces, boldIsBright: config.boldIsBright, background: config.background, foreground: config.foreground, hud: config.hud };
    const key = surfaceKey(terminalId, config_);
    const pooled = surfacePool.get(key);
    const entry = pooled && !pooled.owner && !pooled.ended ? pooled : createSurface(key, terminalId, config_, sdk);
    const reused = entry === pooled;
    surfacePool.delete(key);
    if (entry.timer) window.clearTimeout(entry.timer);
    entry.timer = null;
    entry.owner = owner;
    element.appendChild(entry.container);
    if (reused) marks.current.mark("reused");
    // On focus, claim the session's size again: bb's own terminal tab for the
    // same session may have resized it while it was shown.
    const claim = () => {
      if (!entry.renderer) return;
      const { cols, rows } = entry.renderer.size();
      entry.stream.resize(cols, rows, true);
    };
    element.addEventListener("focusin", claim);
    let removeDiagnostics: (() => void) | null = null;
    void entry.ready.then(
      (created) => {
        if (detached) return;
        marks.current.mark("renderer");
        if (reused) {
          marks.current.mark("attached");
          marks.current.mark("firstFrame");
          setState((current) => (current === "exited" ? current : "open"));
        }
        const { cols, rows } = created.size();
        owner.grid(cols, rows);
        editorFocus.current = () => created.focus();
        if (activeRef.current) editorFocusers.set(threadId, () => created.focus());
        setDiagnostics(created.diagnostics());
        removeDiagnostics = created.onDiagnostics(() => !detached && setDiagnostics(created.diagnostics()));
        // With the HUD on, drivers can also read the screen (status line included).
        if (entry.meter) (window as unknown as { __helixScreen?: () => Promise<string> }).__helixScreen = () => created.term.readText();
        if (autoFocus) {
          // Opening the page focuses the editor. bb's chat tab mounts after us
          // and takes focus, so hold it for a moment unless the user acts.
          let userActed = false;
          const acted = () => (userActed = true);
          window.addEventListener("pointerdown", acted, { capture: true, once: true });
          const take = () => {
            if (detached || userActed || element.contains(document.activeElement)) return;
            created.focus();
            claim();
          };
          take();
          for (const delay of [150, 400, 900, 1600]) window.setTimeout(take, delay);
          window.setTimeout(() => window.removeEventListener("pointerdown", acted, { capture: true }), 2000);
        }
      },
      (error: unknown) => {
        if (detached) return;
        setFailure(error instanceof Error ? error.message : String(error));
        setState("failed");
      },
    );
    const meter = entry.meter;
    if (meter) (window as unknown as { __helixHud?: HudMeter }).__helixHud = meter;
    // With the HUD on, drivers can time the plugin's own RPCs.
    if (meter) (window as unknown as { __helixRpc?: typeof rpc }).__helixRpc = rpc;
    const hudTimer = meter
      ? window.setInterval(() => {
          const snapshot = meter.snapshot();
          setHud({ ...snapshot, lastKey: snapshot.lastKey });
          element.dataset.renderer = entry.renderer?.mode() ?? "";
          // The renderer can change after creation (WebGL attaches its canvas,
          // or falls back to DOM after a lost context): keep the HUD current.
          if (entry.renderer) {
            const next = entry.renderer.diagnostics();
            setDiagnostics((current) => (current && JSON.stringify(current) === JSON.stringify(next) ? current : next));
          }
        }, 500)
      : 0;
    return () => {
      detached = true;
      if (hudTimer) window.clearInterval(hudTimer);
      element.removeEventListener("focusin", claim);
      removeDiagnostics?.();
      if (entry.owner === owner) entry.owner = null;
      entry.container.remove();
      // Kept for a while, attached to its session, for the way back.
      if (entry.ended) entry.dispose();
      else {
        surfacePool.set(key, entry);
        entry.timer = window.setTimeout(() => {
          if (surfacePool.get(key) === entry && !entry.owner) {
            surfacePool.delete(key);
            entry.dispose();
          }
        }, POOL_IDLE_MS);
      }
    };
  }, [terminalId, config.fontFamily, config.fontSize, config.fontStyle, config.faces, config.boldIsBright, config.hud, config.background, config.foreground, autoFocus, sdk]);

  useEffect(() => {
    const element = host.current;
    if (!element || !active) return;
    visibleSurfaces.set(threadId, element);
    return () => {
      if (visibleSurfaces.get(threadId) === element) visibleSurfaces.delete(threadId);
    };
  }, [threadId, active]);

  // :bb-comment with no text: the comment box beside the selection.
  useRealtime("commentRequest", (payload: unknown) => {
    const message = payload as { threadId?: string; request?: CommentRequest } | null;
    if (!active || message?.threadId !== threadId || !message.request?.ranges?.length) return;
    // The box belongs to Helix's pane: a rail sheet over it steps aside.
    if (railSheet.get() === threadId) railSheet.set(null);
    setCommentRequest(message.request);
  });

  // :bb-files (space e in the owner's keys): show the tree on that file and focus it.
  useRealtime("files", (payload: unknown) => {
    const request = payload as { threadId?: string; path?: string | null } | null;
    if (!tree || !active || request?.threadId !== threadId) return;
    const path = request.path ?? null;
    if (showTree && treeHandle.current) {
      if (path) treeHandle.current.reveal(path);
      treeHandle.current.focus();
      return;
    }
    pendingReveal.current = path;
    setTreeOpen(true);
  });

  // A file opened from the tree: back to the editor, and the tree closes
  // (it is a picker) unless the user keeps it open.
  const treeOpened = () => {
    if (!treeStaysOpen) setTreeVisible(false);
    else editorFocus.current?.();
  };

  // Cmd shortcuts (app.tsx): show or hide the tree, move focus between panes.
  const controls = useRef({ toggleTree: () => {}, switchFocus: () => {} });
  controls.current = {
    // The rail's Files tab (the tree); a sheet when bb's sidebar is hidden.
    toggleTree: () => {
      if (tree) {
        if (showTree) setTreeVisible(false);
        else {
          setTreeVisible(true);
          window.setTimeout(() => treeHandle.current?.focus(), 300);
        }
        return;
      }
      if (railSheet.get() === threadId) {
        railSheet.set(null);
        editorFocus.current?.();
        return;
      }
      railTab.set("files");
      if (sidebarRailVisible(threadId)) window.setTimeout(() => railFocus.get(threadId)?.(), 0);
      else railSheet.set(threadId);
    },
    // Between Helix and the rail (or its sheet); from anywhere else (the
    // chat, bb's chrome) straight to Helix.
    switchFocus: () => {
      const inEditor = Boolean(surface.current?.contains(document.activeElement));
      if (!tree && !inEditor && !railHasFocus.get(threadId)?.()) {
        editorFocus.current?.();
        return;
      }
      if (showTree && !treeHandle.current?.focused()) treeHandle.current?.focus();
      else if (!tree && railHasFocus.get(threadId)?.()) {
        if (railSheet.get() === threadId) railSheet.set(null);
        editorFocus.current?.();
      } else if (!tree && sidebarRailVisible(threadId) && railFocus.get(threadId)?.()) return;
      else if (!tree) railSheet.set(threadId);
      else editorFocus.current?.();
    },
  };
  useEffect(() => {
    if (!active) return;
    const entry = { toggleTree: () => controls.current.toggleTree(), switchFocus: () => controls.current.switchFocus() };
    surfaceControls.set(threadId, entry);
    return () => {
      if (surfaceControls.get(threadId) === entry) surfaceControls.delete(threadId);
    };
  }, [threadId, active]);

  const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = treeWidth;
    let width = startWidth;
    const move = (e: PointerEvent) => {
      width = Math.min(TREE_MAX, Math.max(TREE_MIN, startWidth + e.clientX - startX));
      setTreeWidth(width);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      writeStored(widthKey, String(Math.round(width)));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div ref={surface} className={cn("relative flex min-h-0 flex-1 flex-col bg-background", className)} data-helix-surface={threadId}>
      <div className="flex min-h-0 flex-1">
        {showTree ? (
          <>
            <TreePane
              threadId={threadId}
              width={treeWidth}
              config={config}
              handle={treeHandle}
              onQuit={() => setTreeVisible(false)}
              onOpened={treeOpened}
              onReady={() => {
                const path = pendingReveal.current;
                pendingReveal.current = null;
                if (path) treeHandle.current?.reveal(path);
                treeHandle.current?.focus();
              }}
            />
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize the file tree"
              tabIndex={-1}
              onPointerDown={startDrag}
              className="w-1 shrink-0 cursor-col-resize bg-border/60 transition-colors duration-[120ms] hover:bg-ring/60"
              data-helix-tree-divider
            />
          </>
        ) : null}
        <div ref={host} className="helix-surface min-h-0 min-w-0 flex-1 overflow-hidden" data-helix-terminal />
      </div>
      {commentRequest && host.current ? (
        <CommentBox
          threadId={threadId}
          request={commentRequest}
          pane={{ width: host.current.clientWidth, height: host.current.clientHeight }}
          cell={
            diagnostics && diagnostics.dpr > 0
              ? { width: diagnostics.cell.width / diagnostics.dpr, height: diagnostics.cell.height / diagnostics.dpr }
              : { width: host.current.clientWidth / Math.max(1, grid?.cols ?? 80), height: host.current.clientHeight / Math.max(1, grid?.rows ?? 24) }
          }
          onClose={() => {
            setCommentRequest(null);
            editorFocus.current?.();
          }}
        />
      ) : null}
      {state === "exited" ? (
        <div className="absolute inset-0 flex items-center justify-center bg-background p-6" data-helix-exit>
          <div className="flex w-full max-w-xl flex-col gap-3">
            <div className="space-y-1">
              <h2 className="text-sm font-medium">Helix exited{exit?.code !== null && exit?.code !== undefined ? ` with code ${exit.code}` : " unexpectedly"}</h2>
              <p className="text-sm leading-6 text-muted-foreground">The last lines it printed:</p>
            </div>
            <pre className="max-h-64 overflow-auto rounded-lg border border-border/60 bg-muted px-3 py-2.5 font-mono text-xs leading-5 text-foreground">{exit?.lastLines || "(nothing)"}</pre>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={() => {
                  setExit(null);
                  setTerminalId(null);
                  setRestart((n) => n + 1);
                }}
              >
                Reopen
              </Button>
              <Button size="sm" variant="outline" onClick={() => onClosedRef.current()}>
                Close
              </Button>
            </div>
          </div>
        </div>
      ) : state === "failed" ? (
        <div className="absolute inset-0 flex items-center justify-center bg-background/90">
          <EmptyState
            icon="Code"
            title="Helix could not start"
            description={failure ?? "The terminal session failed."}
            action={
              <Button size="sm" onClick={() => setRestart((n) => n + 1)}>
                Try again
              </Button>
            }
          />
        </div>
      ) : null}
      {diagnostics && (!diagnostics.familyInstalled || !diagnostics.requestedLoaded) ? (
        <p className="shrink-0 border-t border-border/60 bg-background px-3 py-1 text-xs text-muted-foreground" role="status" data-helix-font-notice>
          {diagnostics.familyInstalled ? `${diagnostics.requested} did not load` : `${config.fontFamily} is not installed on this computer`}; the editor draws with {diagnostics.font || "a fallback font"}. Install it here (the computer running bb), or set the plugin's font setting.
        </p>
      ) : null}
      {config.hud && hud ? <Hud snapshot={hud} diagnostics={diagnostics} grid={grid} /> : null}
    </div>
  );
}

/** The GPU behind WebGL, once: a software one (SwiftShader, llvmpipe) makes redraw numbers meaningless. */
let gpuName: string | null | undefined;
function gpu(): string | null {
  if (gpuName !== undefined) return gpuName;
  try {
    const gl = document.createElement("canvas").getContext("webgl2") ?? document.createElement("canvas").getContext("webgl");
    const info = gl?.getExtension("WEBGL_debug_renderer_info");
    gpuName = gl && info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : null;
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    gpuName = null;
  }
  return gpuName;
}

function Hud({ snapshot, diagnostics, grid }: { snapshot: HudSnapshot; diagnostics: RendererDiagnostics | null; grid: { cols: number; rows: number } | null }) {
  const name = gpu();
  const software = name !== null && /swiftshader|llvmpipe|software|basic render/iu.test(name);
  const renderer = `${diagnostics?.renderer ?? "?"}${diagnostics?.renderer === "webgl" && name ? (software ? " (software GPU: redraw numbers are not real)" : ` (${name.replace(/^ANGLE \((.*)\)$/u, "$1").slice(0, 40)})`) : ""}`;
  const ms = (v: number | null) => (v === null ? "-" : `${v} ms`);
  return (
    <div
      className="pointer-events-none absolute right-2 top-2 z-10 grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 rounded-md border border-border/60 bg-background/90 px-2.5 py-1.5 text-xs tabular-nums text-muted-foreground"
      data-helix-hud
      aria-live="off"
    >
      <span>Renderer</span>
      <span className="text-foreground">{renderer}</span>
      <span>Font</span>
      <span className="max-w-56 truncate text-foreground">
        {diagnostics ? `${diagnostics.font} (${diagnostics.weight})${diagnostics.requestedLoaded ? "" : ", not the requested face"}` : "-"}
      </span>
      <span>Columns</span>
      <span className={cn("text-foreground", grid && grid.cols < 80 && "text-destructive")}>{grid ? `${grid.cols} x ${grid.rows}` : "-"}</span>
      <span>Pixel ratio</span>
      <span className="text-foreground">{diagnostics ? `${diagnostics.dpr}x, cell ${diagnostics.cell.width}x${diagnostics.cell.height} device px` : "-"}</span>
      <span>Key to paint</span>
      <span className="text-foreground">
        {ms(snapshot.keyToPaint.p50)} p50, {ms(snapshot.keyToPaint.p95)} p95 ({snapshot.keyToPaint.samples})
      </span>
      <span>Redraw</span>
      <span className="text-foreground">
        {ms(snapshot.redraw.p50)} p50, {ms(snapshot.redraw.p95)} p95
      </span>
      <span>Dropped frames</span>
      <span className="text-foreground">{snapshot.droppedFrames}</span>
      <span>Last key</span>
      <span className="max-w-56 truncate font-mono text-foreground">{snapshot.lastKey ?? "-"}</span>
      <span>Sent</span>
      <span className="max-w-56 truncate font-mono text-foreground">{snapshot.lastSent ?? "-"}</span>
    </div>
  );
}

function SurfaceSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col gap-2 bg-background p-4", className)}>
      {Array.from({ length: 8 }, (_, i) => (
        <Skeleton key={i} className={cn("h-4", i % 3 === 0 ? "w-2/5" : i % 3 === 1 ? "w-3/5" : "w-1/3")} />
      ))}
    </div>
  );
}

function SurfaceError({ message, onRetry, className }: { message: string; onRetry(): void; className?: string }) {
  return (
    <div className={cn("flex min-h-0 flex-1 items-center justify-center bg-background p-6", className)}>
      <EmptyState tone="error" icon="AlertCircle" title="The editor cannot start" description={message} action={<Button size="sm" variant="outline" onClick={onRetry}>Try again</Button>} />
    </div>
  );
}

function SetupState({ check, onRetry, className }: { check: { detail: string; fix: string | null }; onRetry(): void; className?: string }) {
  const command = check.fix?.match(/git clone .*?install\.sh/u)?.[0] ?? check.fix ?? "";
  const [copied, setCopied] = useState(false);
  return (
    <div className={cn("flex min-h-0 flex-1 items-center justify-center bg-background p-6", className)}>
      <div className="flex w-full max-w-xl flex-col gap-4">
        <div className="space-y-1">
          <h2 className="text-sm font-medium">Install the Helix fork to edit here</h2>
          <p className="text-sm leading-6 text-muted-foreground">{check.detail.replace(/`/gu, "")}. Run this once in a terminal on this machine; it builds and installs the editor as hxb.</p>
        </div>
        <pre className="overflow-x-auto rounded-lg border border-border/60 bg-muted px-3 py-2.5 font-mono text-xs leading-5 text-foreground">{command}</pre>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={() => {
              void copyToClipboard({ text: command }).then((ok) => setCopied(ok));
            }}
          >
            {copied ? "Copied" : "Copy command"}
          </Button>
          <Button size="sm" variant="outline" onClick={onRetry}>
            Check again
          </Button>
          <span className="ml-auto text-xs text-muted-foreground">
            Details: <code className="font-mono">bb hx doctor</code>
          </span>
        </div>
      </div>
    </div>
  );
}
