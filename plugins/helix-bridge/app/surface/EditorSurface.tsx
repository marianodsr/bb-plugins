// The editor surface: the thread's Helix terminal session, attached over its
// own stream and drawn by Ghostty's core. It owns the keyboard while focused
// (app/terminal/keys.ts). Several surfaces may show the same session (the
// editor page and the thread's Helix tab); only the focused one sends resize,
// so they never fight over the size.
import { useEffect, useRef, useState } from "react";
import { experimental_copyToClipboard as copyToClipboard, useSdk } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { EmptyState, Skeleton } from "../../kit";
import { useGhostty, useHelixRpc, useSetup } from "../data";
import { HudMeter, type HudSnapshot } from "../terminal/hud";
import { installKeyLayer, printable, type OptionAsAlt } from "../terminal/keys";
import { createRenderer, type TerminalRenderer } from "../terminal/renderer";
import { TerminalStream, exitOutcome } from "../terminal/stream";

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
const FALLBACK_FONTS = '"Symbols Nerd Font Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, monospace';

/** Visible surfaces by thread, so a draft's arrival can fly from the editor. */
export const visibleSurfaces = new Map<string, HTMLElement>();

export interface EditorSurfaceProps {
  threadId: string;
  active: boolean;
  autoFocus?: boolean;
  className?: string;
  /**
   * Helix exited cleanly or bb closed its terminal: the session is already
   * closed; the caller takes the surface away (back to the thread, or close
   * the tab).
   */
  onClosed(): void;
}

export function EditorSurface({ threadId, active, autoFocus, className, onClosed }: EditorSurfaceProps) {
  const setup = useSetup();
  const ghostty = useGhostty();
  const binaryMissing = setup.data?.checks.find((c) => c.id === "binary" && c.level === "error") ?? null;

  if (setup.loading && !setup.data) return <SurfaceSkeleton className={className} />;
  if (binaryMissing) return <SetupState check={binaryMissing} onRetry={setup.refetch} className={className} />;
  if (!ghostty.data) {
    if (ghostty.error) return <SurfaceError message={`Could not read the editor settings: ${ghostty.error}`} onRetry={ghostty.refetch} className={className} />;
    return <SurfaceSkeleton className={className} />;
  }
  return <Session threadId={threadId} active={active} autoFocus={autoFocus ?? false} config={ghostty.data} className={className} onClosed={onClosed} />;
}

function Session({
  threadId,
  active,
  autoFocus,
  config,
  className,
  onClosed,
}: {
  onClosed(): void;
  threadId: string;
  active: boolean;
  autoFocus: boolean;
  config: { fontFamily: string | null; fontSize: number | null; fontStyle: string | null; optionAsAlt: OptionAsAlt; hud: boolean; background: string | null; foreground: string | null };
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
  const [hud, setHud] = useState<HudSnapshot | null>(null);
  const [restart, setRestart] = useState(0);
  const activeRef = useRef(active);
  activeRef.current = active;
  const optionRef = useRef<OptionAsAlt>(config.optionAsAlt);
  optionRef.current = config.optionAsAlt;

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
    const owns = () => activeRef.current && element.contains(document.activeElement);
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
    void createRenderer(element, {
      wasmUrl: WASM_URL,
      fontFamily: `${config.fontFamily ? `"${config.fontFamily}", ` : ""}${FALLBACK_FONTS}`,
      fontSize: config.fontSize ?? 13,
      fontWeight: /bold/iu.test(config.fontStyle ?? "") ? "bold" : "normal",
      background: config.background,
      foreground: config.foreground,
      onInput: (data) => {
        stream.input(data);
        if (meter && typeof data === "string") meter.sent(printable(data));
      },
      onResize: (cols, rows) => {
        if (owns()) stream.resize(cols, rows);
      },
      onClipboardWrite: (text) => void copyToClipboard({ text }),
    }).then(
      (created) => {
        if (disposed) {
          created.dispose();
          return;
        }
        renderer = created;
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
        }, 500)
      : 0;
    return () => {
      disposed = true;
      if (hudTimer) window.clearInterval(hudTimer);
      element.removeEventListener("focusin", onFocusIn);
      removeKeys?.();
      stream.close();
      renderer?.dispose();
    };
  }, [terminalId, config.fontFamily, config.fontSize, config.fontStyle, config.hud, autoFocus, sdk]);

  useEffect(() => {
    const element = host.current;
    if (!element || !active) return;
    visibleSurfaces.set(threadId, element);
    return () => {
      if (visibleSurfaces.get(threadId) === element) visibleSurfaces.delete(threadId);
    };
  }, [threadId, active]);

  return (
    <div className={cn("relative flex min-h-0 flex-1 flex-col bg-background", className)} data-helix-surface={threadId}>
      <div ref={host} className="helix-surface min-h-0 flex-1 overflow-hidden" data-helix-terminal />
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
      {config.hud && hud ? <Hud snapshot={hud} renderer={host.current?.dataset.renderer ?? "?"} /> : null}
    </div>
  );
}

function Hud({ snapshot, renderer }: { snapshot: HudSnapshot; renderer: string }) {
  const ms = (v: number | null) => (v === null ? "-" : `${v} ms`);
  return (
    <div
      className="pointer-events-none absolute right-2 top-2 z-10 grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 rounded-md border border-border/60 bg-background/90 px-2.5 py-1.5 text-xs tabular-nums text-muted-foreground"
      data-helix-hud
      aria-live="off"
    >
      <span>Renderer</span>
      <span className="text-foreground">{renderer || "?"}</span>
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
