// Dev-only renderer spike: attach to a bb terminal and render it with one of
// the candidate renderers, full-bleed. `/plugins/helix-bridge/spike/<terminalId>/<renderer>`.
// Exposes `window.__hxSpike` so a headless driver can read key-to-paint
// timings: a capture-phase keydown stamps the key, the renderer's paint
// callback closes the measurement.
import { useEffect, useRef, useState } from "react";
import { createRenderer, RENDERER_KINDS, type RendererKind, type TerminalRenderer } from "./renderer-candidates";
import { TerminalStream } from "../app/terminal/stream";

const WASM_URL = "/api/v1/plugins/helix-bridge/http/wterm-ghostty.wasm";

interface SpikeProbe {
  kind: RendererKind;
  ready: boolean;
  keys: number[];
  paints: number[];
  outputs: { t: number; bytes: number }[];
  inputs: { t: number; bytes: number }[];
  clipboard: string[];
  renderer: TerminalRenderer | null;
  stream: TerminalStream | null;
  reset(): void;
}

declare global {
  interface Window {
    __hxSpike?: SpikeProbe;
  }
}

export function SpikePage({ subPath }: { subPath: string }) {
  const [terminalId = "", rawKind = "ghostty-web"] = subPath.split("/").map((part) => decodeURIComponent(part));
  const kind = (RENDERER_KINDS as readonly string[]).includes(rawKind) ? (rawKind as RendererKind) : "ghostty-web";
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("loading");

  useEffect(() => {
    const element = host.current;
    if (!element || !terminalId) return;
    let disposed = false;
    const probe: SpikeProbe = {
      kind,
      ready: false,
      keys: [],
      paints: [],
      outputs: [],
      inputs: [],
      clipboard: [],
      renderer: null,
      stream: null,
      reset() {
        this.keys.length = this.paints.length = this.outputs.length = this.inputs.length = 0;
      },
    };
    window.__hxSpike = probe;
    const onKey = () => probe.keys.push(performance.now());
    window.addEventListener("keydown", onKey, true);
    let renderer: TerminalRenderer | null = null;
    const stream = new TerminalStream(terminalId, {
      onChunk: (chunk) => {
        probe.outputs.push({ t: performance.now(), bytes: chunk.bytes.length });
        renderer?.write(chunk.bytes);
      },
      onState: setStatus,
    });
    probe.stream = stream;
    void createRenderer(
      kind,
      element,
      {
        fontFamily: '"JetBrainsMono Nerd Font Mono", "MesloLGS NF", ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 13,
        theme: { background: "#1e1e2e", foreground: "#cdd6f4" },
        wterm_wasmUrl: WASM_URL,
      },
      {
        onInput: (data) => {
          probe.inputs.push({ t: performance.now(), bytes: typeof data === "string" ? data.length : data.length });
          stream.input(data);
        },
        onResize: (cols, rows) => stream.resize(cols, rows),
        onClipboardWrite: (text) => probe.clipboard.push(text),
        onPaint: () => probe.paints.push(performance.now()),
      },
    ).then(
      (created) => {
        if (disposed) {
          created.dispose();
          return;
        }
        renderer = created;
        probe.renderer = created;
        stream.connect();
        created.focus();
        probe.ready = true;
      },
      (error: unknown) => setStatus(`failed: ${error instanceof Error ? error.message : String(error)}`),
    );
    return () => {
      disposed = true;
      window.removeEventListener("keydown", onKey, true);
      stream.close();
      renderer?.dispose();
      if (window.__hxSpike === probe) delete window.__hxSpike;
    };
  }, [terminalId, kind]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-7 items-center gap-3 px-3 text-xs text-muted-foreground" data-spike-status={status}>
        <span>{kind}</span>
        <span className="font-mono">{terminalId || "no terminal"}</span>
        <span>{status}</span>
      </div>
      <div ref={host} className="min-h-0 flex-1 overflow-hidden" style={{ background: "#1e1e2e" }} data-spike-host />
    </div>
  );
}
