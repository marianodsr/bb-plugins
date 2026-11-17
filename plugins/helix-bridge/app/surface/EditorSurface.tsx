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
import { TerminalStream } from "../terminal/stream";

const WASM_URL = "/api/v1/plugins/helix-bridge/http/wterm-ghostty.wasm";
const FALLBACK_FONTS = '"Symbols Nerd Font Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, monospace';

/** Visible surfaces by thread, so a draft's arrival can fly from the editor. */
export const visibleSurfaces = new Map<string, HTMLElement>();

export function EditorSurface({ threadId, active, autoFocus, className }: { threadId: string; active: boolean; autoFocus?: boolean; className?: string }) {
  const setup = useSetup();
  const ghostty = useGhostty();
  const binaryMissing = setup.data?.checks.find((c) => c.id === "binary" && c.level === "error") ?? null;

  if (setup.loading && !setup.data) return <SurfaceSkeleton className={className} />;
  if (binaryMissing) return <SetupState check={binaryMissing} onRetry={setup.refetch} className={className} />;
  if (!ghostty.data) {
    if (ghostty.error) return <SurfaceError message={`Could not read the editor settings: ${ghostty.error}`} onRetry={ghostty.refetch} className={className} />;
    return <SurfaceSkeleton className={className} />;
  }
  return <Session threadId={threadId} active={active} autoFocus={autoFocus ?? false} config={ghostty.data} className={className} />;
}

function Session({
  threadId,
  active,
  autoFocus,
  config,
  className,
}: {
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
    const owns = () => activeRef.current && element.contains(document.activeElement);
    const stream = new TerminalStream(terminalId, {
      onChunk: (chunk) => {
        renderer?.write(chunk.bytes);
        meter?.output();
      },
      onState: (next) => {
        if (disposed) return;
        setState(next);
        if (next === "closed")
          void sdk.terminals.get({ terminalId }).then(
            (t) => !disposed && t.status === "exited" && setState("exited"),
            () => {},
          );
      },
    });
    const claim = () => {
      if (!renderer) return;
      const { cols, rows } = renderer.size();
      stream.resize(cols, rows);
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
      {state === "exited" || state === "failed" ? (
        <div className="absolute inset-0 flex items-center justify-center bg-background/90">
          <EmptyState
            icon="Code"
            title={state === "exited" ? "Helix has exited" : "Helix could not start"}
            description={state === "exited" ? "Start it again in this thread's workspace." : (failure ?? "The terminal session failed.")}
            action={
              <Button size="sm" onClick={() => setRestart((n) => n + 1)}>
                Start Helix
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
