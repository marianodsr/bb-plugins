// The app's reads. RPC results are refetched when the server says the
// instance list changed (`instances` realtime signal) or after a reconnect;
// cursor moves arrive only over the `position` signal, so the live line in
// the thread costs no request and no bb write.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import type { AppInstance, GhosttyConfig, Position, rpcContract } from "../server";

export type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
export const useHelixRpc = () => useRpc<typeof rpcContract>();

interface Loaded<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  refetch(): void;
}

/** One RPC read, refetched on the given realtime channels and on reconnect. */
export function useRead<T>(load: (rpc: Rpc) => Promise<T>, deps: readonly unknown[], channels: readonly string[] = ["instances"]): Loaded<T> {
  const rpc = useHelixRpc();
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const refetch = useCallback(() => {
    const mine = ++generation.current;
    setLoading(true);
    load(rpc).then(
      (value) => {
        if (generation.current !== mine) return;
        setData(value);
        setError(null);
        setLoading(false);
      },
      (cause: unknown) => {
        if (generation.current !== mine) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setLoading(false);
      },
    );
  }, [rpc, ...deps]);
  useEffect(() => refetch(), [refetch]);
  for (const channel of channels) {
    // The channel list is static per call site.
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useRealtime(channel, refetch);
  }
  const connection = useRealtimeConnectionState();
  const wasConnected = useRef(connection === "connected");
  useEffect(() => {
    if (connection === "connected" && !wasConnected.current) refetch();
    wasConnected.current = connection === "connected";
  }, [connection, refetch]);
  return { data, error, loading, refetch };
}

/** The Helix serving a thread, with its focus kept live from `position`. */
export function useThreadHelix(threadId: string | null): Loaded<{ instance: AppInstance | null; candidates: number }> & { position: Position | null } {
  const read = useRead((rpc) => (threadId ? rpc.call("threadStatus", { threadId }) : Promise.resolve({ instance: null, candidates: 0 })), [threadId]);
  const key = read.data?.instance?.key ?? null;
  const [position, setPosition] = useState<Position | null>(null);
  useEffect(() => setPosition(null), [key]);
  useRealtime("position", (payload: unknown) => {
    if (!key) return;
    const positions = (payload as { positions?: Position[] } | null)?.positions ?? [];
    const mine = positions.find((p) => p.key === key);
    if (!mine) return;
    setPosition((previous) =>
      previous && previous.path === mine.path && previous.line === mine.line && previous.col === mine.col && previous.endLine === mine.endLine && previous.mode === mine.mode ? previous : mine,
    );
  });
  return { ...read, position };
}

/** The font check in spike/ asks for a style in its own browser only. */
function debugFontStyle(): string | null {
  try {
    return window.localStorage.getItem("helix-bridge.debug.fontStyle");
  } catch {
    return null;
  }
}

export function useGhostty(): Loaded<GhosttyConfig & { hud: boolean }> {
  return useRead((rpc) => {
    const fontStyle = debugFontStyle();
    return rpc.call("ghostty", fontStyle ? { fontStyle } : null);
  }, [], []);
}

export function useSetup(): Loaded<{ ready: boolean; checks: { id: string; label: string; level: "ok" | "warn" | "error"; detail: string; fix: string | null }[] }> {
  return useRead((rpc) => rpc.call("setup", null), [], ["setup"]);
}

export function useInstances(): Loaded<{ instances: AppInstance[] }> {
  return useRead((rpc) => rpc.call("instances", null), []);
}

/** `file:line` for a focus or a live position. */
export function whereLabel(path: string | null | undefined, line: number | null | undefined, endLine?: number | null): string | null {
  if (!path) return null;
  const name = path;
  if (!line) return name;
  return endLine && endLine !== line ? `${name}:${line}-${endLine}` : `${name}:${line}`;
}
