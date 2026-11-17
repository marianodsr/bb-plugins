// The file tree beside the editor: the thread's yazi session ("Files"), drawn
// like the editor and owning the keyboard while focused. Choosing a file
// opens it in Helix (server: `bb hx tree-open`) and focus moves to the editor;
// when Helix's focused file changes the tree reveals it, never while the user
// is moving in the tree. Quitting yazi hides the pane and leaves Helix.
import { useEffect, useRef, useState } from "react";
import { experimental_copyToClipboard as copyToClipboard, useRealtime, useSdk } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Skeleton } from "../../kit";
import { useHelixRpc } from "../data";
import { installKeyLayer, type OptionAsAlt } from "../terminal/keys";
import { createRenderer, type TerminalRenderer } from "../terminal/renderer";
import { TerminalStream, exitOutcome } from "../terminal/stream";

const WASM_URL = "/api/v1/plugins/helix-bridge/http/wterm-ghostty.wasm";
const FALLBACK_FONTS = '"Symbols Nerd Font Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, monospace';
/** No reveal within this long after a key in the tree. */
const QUIET_MS = 1500;
const REVEAL_DEBOUNCE_MS = 250;

/**
 * A terminal's answer to a query (colours, device attributes, modes, cursor
 * position), not a key. yazi asks at start; bb's daemon answers some of it
 * before this surface attaches, so the surface's own answers arrive late and
 * yazi would read them as keys ("ESC ]11;rgb:..." types "/" and opens find).
 */
export function isTerminalReply(data: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /^\x1b[\]P_^]/u.test(data) || /^\x1b\[[?>=][\d;:]*\$?[a-zA-Z]$/u.test(data) || /^\x1b\[\d+;\d+R$/u.test(data) || /^\x1b\[\d+;\d+;\d+t$/u.test(data);
}

export interface TreeHandle {
  focus(): void;
  focused(): boolean;
}

export function TreePane({
  threadId,
  width,
  config,
  handle,
  onQuit,
  onOpened,
}: {
  threadId: string;
  width: number;
  config: { fontFamily: string | null; fontSize: number | null; fontStyle: string | null; optionAsAlt: OptionAsAlt; background: string | null; foreground: string | null };
  handle: { current: TreeHandle | null };
  /** yazi quit (or its session ended): hide the pane. */
  onQuit(): void;
  /** A file chosen here was opened in Helix: focus the editor. */
  onOpened(): void;
}) {
  const rpc = useHelixRpc();
  const sdk = useSdk();
  const host = useRef<HTMLDivElement>(null);
  const [terminalId, setTerminalId] = useState<string | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const optionRef = useRef<OptionAsAlt>(config.optionAsAlt);
  optionRef.current = config.optionAsAlt;
  const onQuitRef = useRef(onQuit);
  onQuitRef.current = onQuit;
  const onOpenedRef = useRef(onOpened);
  onOpenedRef.current = onOpened;
  const lastKeyAt = useRef(0);
  const ready = useRef(false);
  const lastPath = useRef<string | null>(null);
  const revealTimer = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Where Helix is now, so the tree opens on it.
    rpc.call("threadStatus", { threadId }).then(
      ({ instance }) => {
        const path = (instance?.focus as { absolutePath?: string | null } | null | undefined)?.absolutePath ?? null;
        if (!cancelled && path && !lastPath.current) {
          lastPath.current = path;
          if (ready.current) reveal(path);
        }
      },
      () => {},
    );
    rpc.call("treeTerminal", { threadId }).then(
      (result) => {
        if (cancelled) return;
        if (result.terminalId) setTerminalId(result.terminalId);
        else setMissing(result.missing);
      },
      (error: unknown) => !cancelled && setFailure(error instanceof Error ? error.message : String(error)),
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, threadId]);

  const reveal = (path: string) => {
    if (revealTimer.current !== null) window.clearTimeout(revealTimer.current);
    revealTimer.current = window.setTimeout(() => {
      revealTimer.current = null;
      const element = host.current;
      // Never while the user is moving in the tree.
      if (!ready.current || (element && element.contains(document.activeElement) && Date.now() - lastKeyAt.current < QUIET_MS)) return;
      if (Date.now() - lastKeyAt.current < QUIET_MS) return;
      void rpc.call("treeReveal", { threadId, path }).catch(() => {});
    }, REVEAL_DEBOUNCE_MS);
  };

  // Follow Helix's focused file. Refs only: cursor moves never render here.
  useRealtime("position", (payload: unknown) => {
    const mine = ((payload as { positions?: { threadId: string | null; absolutePath?: string | null }[] } | null)?.positions ?? []).find((p) => p.threadId === threadId);
    const path = mine?.absolutePath ?? null;
    if (!path || path === lastPath.current) return;
    lastPath.current = path;
    reveal(path);
  });
  useRealtime("tree-open", (payload: unknown) => {
    if ((payload as { threadId?: string } | null)?.threadId === threadId) onOpenedRef.current();
  });

  useEffect(() => {
    const element = host.current;
    if (!element || !terminalId) return;
    let disposed = false;
    let renderer: TerminalRenderer | null = null;
    const stream = new TerminalStream(terminalId, {
      onChunk: (chunk) => renderer?.write(chunk.bytes),
      onState: (next) => {
        if (next === "open")
          window.setTimeout(() => {
            ready.current = true;
            if (lastPath.current) reveal(lastPath.current);
          }, 600);
      },
      // yazi quit (any exit): close its session and hide the pane; Helix stays.
      onSession: (session) => {
        if (disposed || !exitOutcome(session)) return;
        disposed = true;
        stream.close();
        void sdk.terminals.close({ terminalId, mode: "force" }).catch(() => {});
        onQuitRef.current();
      },
    });
    const claim = () => {
      if (!renderer) return;
      const { cols, rows } = renderer.size();
      stream.resize(cols, rows, true);
    };
    const onKey = () => (lastKeyAt.current = Date.now());
    element.addEventListener("focusin", claim);
    element.addEventListener("keydown", onKey, true);
    let removeKeys: (() => void) | null = null;
    void createRenderer(element, {
      wasmUrl: WASM_URL,
      fontFamily: `${config.fontFamily ? `"${config.fontFamily}", ` : ""}${FALLBACK_FONTS}`,
      fontSize: config.fontSize ?? 13,
      fontWeight: /bold/iu.test(config.fontStyle ?? "") ? "bold" : "normal",
      background: config.background,
      foreground: config.foreground,
      onInput: (data) => {
        if (typeof data === "string" && isTerminalReply(data)) return;
        stream.input(data);
      },
      // The tree is shown in this one place: it always owns its size.
      onResize: (cols, rows) => stream.resize(cols, rows),
      onClipboardWrite: (text) => void copyToClipboard({ text }),
    }).then(
      (created) => {
        if (disposed) {
          created.dispose();
          return;
        }
        renderer = created;
        handle.current = { focus: () => created.focus(), focused: () => element.contains(document.activeElement) };
        removeKeys = installKeyLayer(element, {
          optionAsAlt: () => optionRef.current,
          kittyFlags: () => created.kittyFlags(),
          selection: () => created.selection(),
          copy: (text) => void copyToClipboard({ text }),
          send: (data) => stream.input(data),
        });
        stream.connect();
        claim();
      },
      (error: unknown) => setFailure(error instanceof Error ? error.message : String(error)),
    );
    return () => {
      disposed = true;
      ready.current = false;
      if (revealTimer.current !== null) window.clearTimeout(revealTimer.current);
      element.removeEventListener("focusin", claim);
      element.removeEventListener("keydown", onKey, true);
      removeKeys?.();
      stream.close();
      renderer?.dispose();
      handle.current = null;
    };
  }, [terminalId, config.fontFamily, config.fontSize, config.fontStyle, sdk, handle]);

  return (
    <div className="relative flex min-h-0 shrink-0 flex-col bg-background" style={{ width }} data-helix-tree={threadId}>
      <div ref={host} className={cn("helix-surface min-h-0 flex-1 overflow-hidden", (missing || failure) && "hidden")} data-helix-tree-terminal />
      {missing ? <TreeSetup command={missing} /> : failure ? <p className="p-3 text-xs leading-5 text-muted-foreground">The file tree could not start: {failure}</p> : !terminalId ? <TreeSkeleton /> : null}
    </div>
  );
}

function TreeSkeleton() {
  return (
    <div className="flex flex-col gap-2 p-3">
      {Array.from({ length: 6 }, (_, i) => (
        <Skeleton key={i} className={cn("h-3.5", i % 2 === 0 ? "w-3/5" : "w-2/5")} />
      ))}
    </div>
  );
}

function TreeSetup({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const isCommand = !/\s/u.test(command.trim()) || /^(brew|cargo|sudo|apt|pacman) /u.test(command);
  return (
    <div className="flex flex-col gap-2 p-3 text-xs leading-5" data-helix-tree-setup>
      <p className="font-medium text-foreground">Files appear here with yazi</p>
      <p className="text-muted-foreground">{isCommand ? "Install it once on this machine, then show the tree again." : command}</p>
      {isCommand ? (
        <>
          <pre className="overflow-x-auto rounded-md border border-border/60 bg-muted px-2 py-1.5 font-mono text-foreground">{command}</pre>
          <Button size="sm" variant="outline" className="self-start" onClick={() => void copyToClipboard({ text: command }).then((ok) => setCopied(ok))}>
            {copied ? "Copied" : "Copy command"}
          </Button>
        </>
      ) : null}
    </div>
  );
}
