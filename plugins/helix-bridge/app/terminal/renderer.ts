// The terminal renderer behind the editor surface: Ghostty's VT core
// (@wterm/ghostty, WebAssembly) drawn by @wterm/dom with its WebGL renderer,
// which falls back to the DOM renderer without WebGL2 or after a lost
// context. Kept thin so the renderer can be swapped (spike/RESULTS.md).
import "@wterm/dom/css";
import "./surface.css";
import { WTerm } from "@wterm/dom";
import { GhosttyCore } from "@wterm/ghostty";

const FALLBACK_FONTS = '"Symbols Nerd Font Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, monospace';
const FLAG_BOLD = 0x01;
const DEFAULT_COLOR = 256;

interface Face {
  fullName: string;
  postscriptName: string | null;
}

export interface SurfaceFont {
  /** Ghostty's (or the plugin's) font-family; null uses the fallbacks. */
  family: string | null;
  size: number;
  /** Ghostty's font-style, the base face (for example "Bold"). */
  style: string | null;
  /** The installed faces for that family and its styles (host, fontconfig). */
  faces?: { regular: Face | null; bold: Face | null; italic: Face | null; boldItalic: Face | null } | undefined;
}

export interface RendererOptions {
  wasmUrl: string;
  font: SurfaceFont;
  /** Ghostty's bold-is-bright: bold text in palette colours 0-7 uses 8-15. */
  boldIsBright?: boolean;
  /** Ghostty's `background` / `foreground`, when its config sets them. */
  background: string | null;
  foreground: string | null;
  onInput(data: string | Uint8Array): void;
  onResize(cols: number, rows: number): void;
  onClipboardWrite(text: string): void;
}

/** What the surface actually draws with, for the HUD and the missing-font notice. */
export interface RendererDiagnostics {
  /** The first family in use: the alias of the configured face, or the family itself. */
  font: string;
  /** Ghostty's face for normal text (the base style), or the family when there is none. */
  requested: string;
  /** The requested face is installed and loaded (false: a fallback draws). */
  requestedLoaded: boolean;
  /** The configured family is installed on this computer (the one running bb's app). */
  familyInstalled: boolean;
  weight: string;
  dpr: number;
  /** One cell in device pixels: whole numbers keep glyphs sharp in WebGL. */
  cell: { width: number; height: number };
  renderer: "webgl" | "dom";
}

export interface TerminalRenderer {
  readonly term: WTerm;
  diagnostics(): RendererDiagnostics;
  /** Called when diagnostics change (font loaded, display changed). */
  onDiagnostics(listener: () => void): () => void;
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

function src(face: Face | null, fallback: string[]): string {
  const names = face ? [face.fullName, face.postscriptName].filter((n): n is string => Boolean(n)) : fallback;
  return names.map((n) => `local("${n.replace(/"/gu, "")}")`).join(", ");
}

/**
 * The font the surface draws with. wterm's WebGL atlas asks the canvas for
 * "<bold?> <size>px <family>": it has no notion of a base weight, so Ghostty's
 * font-style (a heavier base face, say Bold) never reached it, and the DOM
 * path had it only through the element's font-weight. Instead the surface
 * uses an alias family whose normal weight IS the base face and whose bold
 * weight is the bold style (the same face when the base is Bold, as in
 * Ghostty), both by `local()` name, and loads them before the first glyph is
 * rasterised, so the atlas never caches a fallback face.
 */
/** The family is installed (in this browser) when text in it measures unlike both generic fallbacks. */
export function familyInstalled(family: string): boolean {
  try {
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return true;
    const sample = "mmmmmmmmmmlliWW@0O";
    const width = (f: string) => {
      ctx.font = `32px ${f}`;
      return ctx.measureText(sample).width;
    };
    const quoted = `"${family.replace(/"/gu, "")}"`;
    return width(`${quoted}, monospace`) !== width("monospace") || width(`${quoted}, serif`) !== width("serif");
  } catch {
    return true;
  }
}

/**
 * Snap the cell to whole device pixels. wterm's WebGL renderer samples its
 * glyph atlas with NEAREST filtering at col * charWidth * dpr; a fractional
 * product (Fira Code at 17 px is 10.2 px wide; scaled displays and zoom give
 * ratios like 1.5) drops or doubles glyph columns, which reads as jagged
 * text. A small letter-spacing rounds the measured advance to a whole number
 * of device pixels and the row height is rounded the same way; the DOM
 * renderer uses the same grid.
 */
function noSnap(): boolean {
  try {
    return window.localStorage.getItem("helix-bridge.debug.nosnap") === "1";
  } catch {
    return false;
  }
}

function snapCell(element: HTMLElement, size: number): { dpr: number; width: number; height: number } {
  const dpr = window.devicePixelRatio || 1;
  if (noSnap()) {
    // The font check's "before": wterm's own fractional cell.
    element.style.letterSpacing = "0px";
    element.style.setProperty("--term-row-height", `${Math.ceil(size * 1.2)}px`);
    return { dpr, width: 0, height: Math.ceil(size * 1.2) * dpr };
  }
  element.style.letterSpacing = "0px";
  const probe = document.createElement("span");
  probe.textContent = "W".repeat(20);
  probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;font-family:var(--term-font-family);font-size:var(--term-font-size);letter-spacing:0";
  element.appendChild(probe);
  const natural = probe.getBoundingClientRect().width / 20;
  probe.remove();
  const width = natural > 0 ? Math.max(1, Math.round(natural * dpr)) / dpr : 0;
  if (natural > 0) element.style.letterSpacing = `${width - natural}px`;
  const height = Math.max(1, Math.round(Math.ceil(size * 1.2) * dpr)) / dpr;
  element.style.setProperty("--term-row-height", `${height}px`);
  return { dpr, width: Math.round(width * dpr), height: Math.round(height * dpr) };
}

export async function surfaceFontFamily(font: SurfaceFont): Promise<string> {
  const family = font.family ? `"${font.family.replace(/"/gu, "")}"` : null;
  const style = font.style && font.style !== "false" && font.style.toLowerCase() !== "regular" ? font.style : null;
  const faces = font.faces;
  if (!font.family || (!style && !faces?.bold && !faces?.italic && !faces?.boldItalic)) return [family, FALLBACK_FONTS].filter(Boolean).join(", ");
  const compact = font.family.replace(/\s+/gu, "");
  const guess = (s: string) => [`${font.family} ${s}`, `${compact}-${s.replace(/\s+/gu, "")}`];
  const alias = `Helix Bridge ${font.family} ${style ?? "Regular"}`.replace(/"/gu, "");
  const id = `helix-bridge-font-${alias.replace(/[^\w-]+/gu, "-")}`;
  const rules: string[] = [];
  const regular = style ? src(faces?.regular ?? null, guess(style)) : src(null, [font.family]);
  rules.push(`@font-face { font-family: "${alias}"; src: ${regular}; font-weight: 400; font-style: normal; }`);
  const bold = faces?.bold ? src(faces.bold, []) : style ? regular : src(null, guess("Bold"));
  rules.push(`@font-face { font-family: "${alias}"; src: ${bold}; font-weight: 700; font-style: normal; }`);
  if (faces?.italic) rules.push(`@font-face { font-family: "${alias}"; src: ${src(faces.italic, [])}; font-weight: 400; font-style: italic; }`);
  if (faces?.boldItalic) rules.push(`@font-face { font-family: "${alias}"; src: ${src(faces.boldItalic, [])}; font-weight: 700; font-style: italic; }`);
  let tag = document.getElementById(id) as HTMLStyleElement | null;
  if (!tag) {
    tag = document.createElement("style");
    tag.id = id;
    document.head.appendChild(tag);
  }
  tag.textContent = rules.join("\n");
  await Promise.all([document.fonts.load(`400 ${font.size}px "${alias}"`), document.fonts.load(`700 ${font.size}px "${alias}"`)]).catch(() => []);
  // A face that did not load (a wrong local name) leaves the plain family.
  const ok = document.fonts.check(`400 ${font.size}px "${alias}"`);
  return [ok ? `"${alias}"` : null, family, FALLBACK_FONTS].filter(Boolean).join(", ");
}

/** Debug switches for the font check in spike/ (this browser only). */
function forcedRenderer(): "webgl" | "dom" {
  try {
    return window.localStorage.getItem("helix-bridge.debug.renderer") === "dom" ? "dom" : "webgl";
  } catch {
    return "webgl";
  }
}

let corePromise: Promise<typeof GhosttyCore> | null = null;

export async function createRenderer(element: HTMLElement, options: RendererOptions): Promise<TerminalRenderer> {
  corePromise ??= Promise.resolve(GhosttyCore);
  const Core = await corePromise;
  const core = await Core.load({ wasmPath: options.wasmUrl, scrollbackLines: 5000 });
  if (options.boldIsBright) {
    // Both renderers read cells through getCell.
    const getCell = core.getCell.bind(core);
    core.getCell = (row: number, col: number) => {
      const cell = getCell(row, col);
      return cell.flags & FLAG_BOLD && cell.fgRgb === undefined && cell.fg >= 0 && cell.fg < 8 && cell.fg !== DEFAULT_COLOR ? { ...cell, fg: cell.fg + 8 } : cell;
    };
  }
  const fontFamily = await surfaceFontFamily(options.font);
  element.style.setProperty("--term-font-family", fontFamily);
  element.style.setProperty("--term-font-size", `${options.font.size}px`);
  element.style.fontWeight = "normal";
  let cell = snapCell(element, options.font.size);
  const style = options.font.style && options.font.style !== "false" && options.font.style.toLowerCase() !== "regular" ? options.font.style : null;
  const aliased = fontFamily.startsWith('"Helix Bridge ');
  const installed = options.font.family ? familyInstalled(options.font.family) : true;
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };
  const hex = (value: string | null) => (value && /^#?[0-9a-f]{6}$/iu.test(value) ? (value.startsWith("#") ? value : `#${value}`) : null);
  // Without Ghostty colours the defaults are bb's background and text, which
  // bb writes as oklch(); the WebGL renderer reads only sRGB, so resolve them.
  element.style.setProperty("--term-bg", hex(options.background) ?? toHex(getComputedStyle(element).getPropertyValue("--background")) ?? "#000000");
  element.style.setProperty("--term-fg", hex(options.foreground) ?? toHex(getComputedStyle(element).getPropertyValue("--foreground")) ?? "#ffffff");
  const term = new WTerm(element, {
    core,
    renderer: forcedRenderer(),
    autoResize: true,
    cursorBlink: false,
    onData: (data) => options.onInput(data),
    onBinary: (bytes) => options.onInput(bytes),
    onResize: (cols, rows) => options.onResize(cols, rows),
    onClipboardWrite: (text) => options.onClipboardWrite(text),
  });
  await term.init();
  options.onResize(term.cols, term.rows);
  // Redraw at the new resolution when the window moves to another display,
  // the scaling changes or the page is zoomed: re-snap the cell, refit, and
  // repaint (the atlas is keyed by the ratio, so it is rebuilt).
  let media: MediaQueryList | null = null;
  const repaint = () => {
    cell = snapCell(element, options.font.size);
    term.fit();
    term.setRenderingPaused(true);
    term.setRenderingPaused(false);
    changed();
  };
  const watchRatio = () => {
    media?.removeEventListener("change", onRatio);
    media = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    media.addEventListener("change", onRatio);
  };
  const onRatio = () => {
    repaint();
    watchRatio();
  };
  watchRatio();
  // A face that loads after the first glyphs were drawn: use it, on a new atlas.
  const onFonts = () => {
    if (!style || aliased) return;
    void surfaceFontFamily(options.font).then((family) => {
      if (!family.startsWith('"Helix Bridge ')) return;
      element.style.setProperty("--term-font-family", family);
      repaint();
    });
  };
  document.fonts.addEventListener("loadingdone", onFonts);
  return {
    term,
    diagnostics: () => {
      const current = getComputedStyle(element).getPropertyValue("--term-font-family");
      const first = current.split(",")[0]?.trim().replace(/^"|"$/gu, "") ?? "";
      return {
        font: first,
        requested: style ? (options.font.faces?.regular?.fullName ?? `${options.font.family} ${style}`) : (options.font.family ?? "(fallback fonts)"),
        requestedLoaded: style ? first.startsWith("Helix Bridge ") : installed,
        familyInstalled: installed,
        weight: style ?? "Regular",
        dpr: window.devicePixelRatio || 1,
        cell: { width: cell.width, height: cell.height },
        renderer: element.querySelector("canvas.term-gpu-canvas:not([hidden])") ? "webgl" : "dom",
      };
    },
    onDiagnostics: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    write: (bytes) => term.write(bytes),
    focus: () => term.focus(),
    fit: () => term.fit(),
    size: () => ({ cols: term.cols, rows: term.rows }),
    // WebGL draws on .term-gpu-canvas; hidden (or absent) means the DOM rows draw.
    mode: () => (element.querySelector<HTMLCanvasElement>("canvas.term-gpu-canvas:not([hidden])") ? "webgl" : "dom"),
    kittyFlags: () => term.bridge?.kittyKeyboardFlags?.() ?? 0,
    selection: () => term.getSelectionText(),
    dispose: () => {
      media?.removeEventListener("change", onRatio);
      document.fonts.removeEventListener("loadingdone", onFonts);
      term.destroy();
    },
  };
}
