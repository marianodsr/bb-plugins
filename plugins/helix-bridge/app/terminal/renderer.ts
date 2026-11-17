// The terminal renderer behind the editor surface: Ghostty's VT core
// (@wterm/ghostty, WebAssembly) drawn by @wterm/dom with its WebGL renderer,
// which falls back to the DOM renderer without WebGL2 or after a lost
// context. Kept thin so the renderer can be swapped (spike/RESULTS.md).
import "@wterm/dom/css";
import "./surface.css";
import { WTerm } from "@wterm/dom";
import { GhosttyCore } from "@wterm/ghostty";

export interface RendererOptions {
  wasmUrl: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: string;
  /** Ghostty's `background` / `foreground`, when its config sets them. */
  background: string | null;
  foreground: string | null;
  onInput(data: string | Uint8Array): void;
  onResize(cols: number, rows: number): void;
  onClipboardWrite(text: string): void;
}

export interface TerminalRenderer {
  readonly term: WTerm;
  write(bytes: Uint8Array): void;
  focus(): void;
  fit(): void;
  size(): { cols: number; rows: number };
  /** "webgl" while the GPU canvas paints, else "dom". */
  mode(): "webgl" | "dom";
  kittyFlags(): number;
  selection(): string | null;
  dispose(): void;
}

/** Any CSS colour as #rrggbb, by painting one pixel. */
export function toHex(css: string): string | null {
  const value = css.trim();
  if (!value) return null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.fillStyle = "#000";
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    return `#${[r, g, b].map((n) => (n ?? 0).toString(16).padStart(2, "0")).join("")}`;
  } catch {
    return null;
  }
}

let corePromise: Promise<typeof GhosttyCore> | null = null;

export async function createRenderer(element: HTMLElement, options: RendererOptions): Promise<TerminalRenderer> {
  corePromise ??= Promise.resolve(GhosttyCore);
  const Core = await corePromise;
  const core = await Core.load({ wasmPath: options.wasmUrl, scrollbackLines: 5000 });
  element.style.setProperty("--term-font-family", options.fontFamily);
  element.style.setProperty("--term-font-size", `${options.fontSize}px`);
  element.style.setProperty("--term-row-height", `${Math.ceil(options.fontSize * 1.2)}px`);
  element.style.fontWeight = options.fontWeight;
  const hex = (value: string | null) => (value && /^#?[0-9a-f]{6}$/iu.test(value) ? (value.startsWith("#") ? value : `#${value}`) : null);
  // Without Ghostty colours the defaults are bb's background and text, which
  // bb writes as oklch(); the WebGL renderer reads only sRGB, so resolve them.
  element.style.setProperty("--term-bg", hex(options.background) ?? toHex(getComputedStyle(element).getPropertyValue("--background")) ?? "#000000");
  element.style.setProperty("--term-fg", hex(options.foreground) ?? toHex(getComputedStyle(element).getPropertyValue("--foreground")) ?? "#ffffff");
  const term = new WTerm(element, {
    core,
    renderer: "webgl",
    autoResize: true,
    cursorBlink: false,
    onData: (data) => options.onInput(data),
    onBinary: (bytes) => options.onInput(bytes),
    onResize: (cols, rows) => options.onResize(cols, rows),
    onClipboardWrite: (text) => options.onClipboardWrite(text),
  });
  await term.init();
  options.onResize(term.cols, term.rows);
  return {
    term,
    write: (bytes) => term.write(bytes),
    focus: () => term.focus(),
    fit: () => term.fit(),
    size: () => ({ cols: term.cols, rows: term.rows }),
    mode: () => {
      const canvas = element.querySelector("canvas");
      return canvas && !canvas.hidden ? "webgl" : "dom";
    },
    kittyFlags: () => term.bridge?.kittyKeyboardFlags?.() ?? 0,
    selection: () => term.getSelectionText(),
    dispose: () => term.destroy(),
  };
}
