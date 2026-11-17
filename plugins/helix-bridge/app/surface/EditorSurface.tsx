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
    rpc.call("editorTerminal", { threadId }).then(
      ({ terminalId: id }) => !cancelled && setTerminalId(id),
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
    let disposed = false;
    let renderer: TerminalRenderer | null = null;
    const meter = config.hud ? new HudMeter() : null;
    // With the HUD on, drivers can read and reset the raw samples.
    if (meter) (window as unknown as { __helixHud?: HudMeter }).__helixHud = meter;
    const tail = new OutputTail();
    // The editor owns its size while focus is anywhere in this surface (the
    // tree beside it changes its width); another surface showing the same
    // session (the thread's tab) never fights it.
    const owns = () => activeRef.current && Boolean(surface.current?.contains(document.activeElement));
    const stream = new TerminalStream(terminalId, {
      onChunk: (chunk) => {
        renderer?.write(chunk.bytes);
        tail.push(chunk.bytes);
        meter?.output();
      },
      onState: (next) => {
        if (disposed) return;
        if (next !== "closed") setState((current) => (current === "exited" ? current : next));
      },
      // The stream says at once when the process ends (also on attach, when
      // it ended while no surface was open).
      onSession: (session) => {
        if (disposed) return;
        // bb reports exit code 0 for a process killed by a signal; a Rust panic
        // left on screen still means a crash.
        const outcome = exitOutcome(session) === "close" && /panicked at /u.test(tail.text()) ? "report" : exitOutcome(session);
        if (!outcome) return;
        disposed = true;
        stream.close();
        // The tree goes with the editor.
        closeTreeRef.current();
        if (outcome === "close") {
          void sdk.terminals.close({ terminalId, mode: "force" }).catch(() => {});
          onClosedRef.current();
          return;
        }
        setState("exited");
        // What is left on the terminal's screen once Helix has left its
        // alternate screen: a panic message lands there. Raw output is screen
        // painting, not lines, so it is only the fallback.
        const screen = renderer ? renderer.term.readText().catch(() => "") : Promise.resolve("");
        void screen.then((text) => {
          setExit({ code: session.exitCode, lastLines: lastLines(text || tail.text()) });
          void sdk.terminals.close({ terminalId, mode: "force" }).catch(() => {});
        });
      },
    });
    // On focus, claim the session's size again: bb's own terminal tab for the
    // same session may have resized it while it was shown.
    const claim = () => {
      if (!renderer) return;
      const { cols, rows } = renderer.size();
      stream.resize(cols, rows, true);
    };
    const onFocusIn = () => claim();
    element.addEventListener("focusin", onFocusIn);
    let removeKeys: (() => void) | null = null;
    let removeDiagnostics: (() => void) | null = null;
    void createRenderer(element, {
      wasmUrl: WASM_URL,
      font: { family: config.fontFamily, size: config.fontSize ?? 13, style: config.fontStyle, faces: config.faces },
      boldIsBright: config.boldIsBright === true,
      background: config.background,
      foreground: config.foreground,
      onInput: (data) => {
        stream.input(data);
        if (meter && typeof data === "string") meter.sent(printable(data));
      },
      onResize: (cols, rows) => {
        if (owns()) stream.resize(cols, rows);
        element.dataset.cols = String(cols);
        setGrid({ cols, rows });
        window.dispatchEvent(new CustomEvent("helix-bridge:grid", { detail: { threadId, cols, rows } }));
      },
      onClipboardWrite: (text) => void copyToClipboard({ text }),
    }).then(
      (created) => {
        if (disposed) {
          created.dispose();
          return;
        }
        renderer = created;
        {
          const { cols, rows } = created.size();
          element.dataset.cols = String(cols);
          setGrid({ cols, rows });
          window.dispatchEvent(new CustomEvent("helix-bridge:grid", { detail: { threadId, cols, rows } }));
        }
        editorFocus.current = () => created.focus();
        if (activeRef.current) editorFocusers.set(threadId, () => created.focus());
        setDiagnostics(created.diagnostics());
        removeDiagnostics = created.onDiagnostics(() => !disposed && setDiagnostics(created.diagnostics()));
        // With the HUD on, drivers can also read the screen (status line included).
        if (meter) (window as unknown as { __helixScreen?: () => Promise<string> }).__helixScreen = () => created.term.readText();
        removeKeys = installKeyLayer(element, {
          optionAsAlt: () => optionRef.current,
          kittyFlags: () => created.kittyFlags(),
          selection: () => created.selection(),
          copy: (text) => void copyToClipboard({ text }),
          send: (data) => {
            stream.input(data);
            meter?.sent(printable(data));
          },
          observe: (key) => meter?.key(key),
        });
        stream.connect();
        if (autoFocus) {
          // Opening the page focuses the editor. bb's chat tab mounts after us
          // and takes focus, so hold it for a moment unless the user acts.
          let userActed = false;
          const acted = () => (userActed = true);
          window.addEventListener("pointerdown", acted, { capture: true, once: true });
          const take = () => {
            if (disposed || userActed || element.contains(document.activeElement)) return;
            created.focus();
            claim();
          };
          take();
          for (const delay of [150, 400, 900, 1600]) window.setTimeout(take, delay);
          window.setTimeout(() => window.removeEventListener("pointerdown", acted, { capture: true }), 2000);
        }
      },
      (error: unknown) => {
        setFailure(error instanceof Error ? error.message : String(error));
        setState("failed");
      },
    );
    const hudTimer = meter
      ? window.setInterval(() => {
          const snapshot = meter.snapshot();
          setHud({ ...snapshot, lastKey: snapshot.lastKey });
          element.dataset.renderer = renderer?.mode() ?? "";
          // The renderer can change after creation (WebGL attaches its canvas,
          // or falls back to DOM after a lost context): keep the HUD current.
          if (renderer) {
            const next = renderer.diagnostics();
            setDiagnostics((current) => (current && JSON.stringify(current) === JSON.stringify(next) ? current : next));
          }
        }, 500)
      : 0;
    return () => {
      disposed = true;
      if (hudTimer) window.clearInterval(hudTimer);
      element.removeEventListener("focusin", onFocusIn);
      removeKeys?.();
      removeDiagnostics?.();
      stream.close();
      renderer?.dispose();
    };
  }, [terminalId, config.fontFamily, config.fontSize, config.fontStyle, config.faces, config.boldIsBright, config.hud, autoFocus, sdk]);

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
    // Between Helix and the rail (or its sheet).
    switchFocus: () => {
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

function Hud({ snapshot, diagnostics, grid }: { snapshot: HudSnapshot; diagnostics: RendererDiagnostics | null; grid: { cols: number; rows: number } | null }) {
  const renderer = diagnostics?.renderer ?? "?";
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
