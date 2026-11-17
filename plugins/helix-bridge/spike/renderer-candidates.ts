// One interface over the terminal renderers the spike compares, so the
// editor surface can swap them. Each renderer owns its element's keyboard,
// mouse and paste handling and reports what it wants sent to the PTY.
import "@wterm/dom/css";

export type RendererKind = "ghostty-web" | "wterm-dom" | "wterm-webgl";
export const RENDERER_KINDS: readonly RendererKind[] = ["ghostty-web", "wterm-dom", "wterm-webgl"];

export interface RendererOptions {
  fontFamily: string;
  fontSize: number;
  theme: { background: string; foreground: string };
  /** URL of the Ghostty VT WebAssembly binary for the wterm core. */
  wterm_wasmUrl: string;
}

export interface RendererCallbacks {
  onInput(data: string | Uint8Array): void;
  onResize(cols: number, rows: number): void;
  onClipboardWrite?(text: string): void;
  /** After the renderer has painted what it was given. */
  onPaint?(): void;
}

export interface TerminalRenderer {
  readonly kind: RendererKind;
  write(bytes: Uint8Array): void;
  focus(): void;
  fit(): void;
  size(): { cols: number; rows: number };
  /** Bytes of WebAssembly memory the core holds, when it says. */
  wasmBytes(): number | null;
  dispose(): void;
}

export async function createRenderer(
  kind: RendererKind,
  element: HTMLElement,
  options: RendererOptions,
  callbacks: RendererCallbacks,
): Promise<TerminalRenderer> {
  if (kind === "ghostty-web") return createGhosttyWeb(element, options, callbacks);
  return createWterm(kind === "wterm-webgl" ? "webgl" : "dom", element, options, callbacks);
}

async function createGhosttyWeb(element: HTMLElement, options: RendererOptions, callbacks: RendererCallbacks): Promise<TerminalRenderer> {
  const { Ghostty, Terminal, FitAddon } = await import("ghostty-web");
  const ghostty = await Ghostty.load();
  const term = new Terminal({
    ghostty,
    fontFamily: options.fontFamily,
    fontSize: options.fontSize,
    theme: options.theme,
    cursorBlink: false,
    scrollback: 5000,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(element);
  const data = term.onData((value) => callbacks.onInput(value));
  const resize = term.onResize(({ cols, rows }) => callbacks.onResize(cols, rows));
  fit.fit();
  fit.observeResize();
  callbacks.onResize(term.cols, term.rows);
  const memory = (ghostty as unknown as { exports?: { memory?: WebAssembly.Memory } }).exports?.memory;
  return {
    kind: "ghostty-web",
    write: (bytes) => {
      term.write(bytes);
      // ghostty-web paints from its own animation-frame loop (its onRender
      // event never fires); a frame queued now runs after that paint.
      if (callbacks.onPaint) requestAnimationFrame(() => callbacks.onPaint?.());
    },
    focus: () => term.focus(),
    fit: () => fit.fit(),
    size: () => ({ cols: term.cols, rows: term.rows }),
    wasmBytes: () => memory?.buffer.byteLength ?? null,
    dispose: () => {
      data.dispose();
      resize.dispose();
      term.dispose();
    },
  };
}

async function createWterm(
  renderer: "dom" | "webgl",
  element: HTMLElement,
  options: RendererOptions,
  callbacks: RendererCallbacks,
): Promise<TerminalRenderer> {
  const [{ WTerm }, { GhosttyCore }] = await Promise.all([import("@wterm/dom"), import("@wterm/ghostty")]);
  const core = await GhosttyCore.load({ wasmPath: options.wterm_wasmUrl, scrollbackLines: 5000 });
  element.style.fontFamily = options.fontFamily;
  element.style.fontSize = `${options.fontSize}px`;
  element.style.setProperty("--term-bg", options.theme.background);
  element.style.setProperty("--term-fg", options.theme.foreground);
  const term = new WTerm(element, {
    core,
    renderer,
    autoResize: true,
    cursorBlink: false,
    onData: (value) => callbacks.onInput(value),
    onBinary: (bytes) => callbacks.onInput(bytes),
    onResize: (cols, rows) => callbacks.onResize(cols, rows),
    onClipboardWrite: (text) => callbacks.onClipboardWrite?.(text),
  });
  await term.init();
  callbacks.onResize(term.cols, term.rows);
  const memory = (core as unknown as { wasm?: { exports?: { memory?: WebAssembly.Memory } } }).wasm?.exports?.memory;
  return {
    kind: renderer === "webgl" ? "wterm-webgl" : "wterm-dom",
    write: (bytes) => {
      term.write(bytes);
      // wterm paints on the next animation frame; this callback queues after it.
      if (callbacks.onPaint) requestAnimationFrame(() => callbacks.onPaint?.());
    },
    focus: () => term.focus(),
    fit: () => term.fit(),
    size: () => ({ cols: term.cols, rows: term.rows }),
    wasmBytes: () => memory?.buffer.byteLength ?? null,
    dispose: () => term.destroy(),
  };
}
