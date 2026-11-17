// The editor surface's own key layer, in front of wterm's.
//
// - Cmd belongs to bb: Cmd chords pass through untouched (bb's shortcuts keep
//   working, and Helix cannot use Cmd). Except Cmd+C, which copies the
//   surface's selection when there is one; Cmd+V reaches the textarea as a
//   paste event, which wterm sends as bracketed paste.
// - Option follows Ghostty's `macos-option-as-alt` (true, left, right, false).
//   Browsers report Option+x as "≈" or a dead key, so the base key comes from
//   `KeyboardEvent.code` (US layout) and is sent as Alt: `ESC x`, or the Kitty
//   sequence when Helix has turned the protocol on.
// - Everything else is wterm's, and handled keys never bubble to bb.

export type OptionAsAlt = "true" | "false" | "left" | "right";

const LETTER = /^Key([A-Z])$/u;
const DIGIT = /^Digit([0-9])$/u;
const SHIFTED_DIGITS = ")!@#$%^&*(";
const PUNCTUATION: Record<string, [string, string]> = {
  Minus: ["-", "_"],
  Equal: ["=", "+"],
  BracketLeft: ["[", "{"],
  BracketRight: ["]", "}"],
  Backslash: ["\\", "|"],
  Semicolon: [";", ":"],
  Quote: ["'", '"'],
  Comma: [",", "<"],
  Period: [".", ">"],
  Slash: ["/", "?"],
  Backquote: ["`", "~"],
  Space: [" ", " "],
};

/** The character a US layout gives this physical key, with and without shift. */
export function baseKey(code: string): { plain: string; shifted: string } | null {
  const letter = LETTER.exec(code);
  if (letter) return { plain: letter[1]!.toLowerCase(), shifted: letter[1]! };
  const digit = DIGIT.exec(code);
  if (digit) return { plain: digit[1]!, shifted: SHIFTED_DIGITS[Number(digit[1])]! };
  const punct = PUNCTUATION[code];
  return punct ? { plain: punct[0], shifted: punct[1] } : null;
}

export function optionApplies(setting: OptionAsAlt, location: number): boolean {
  if (setting === "true") return true;
  if (setting === "left") return location === 1; // KeyboardEvent.DOM_KEY_LOCATION_LEFT
  if (setting === "right") return location === 2;
  return false;
}

const KITTY_REPORT_ALTERNATES = 1 << 2;

/**
 * Bytes for an Alt chord on a printable key, or null when it is not one.
 * Legacy: ESC + the character (Ctrl+Alt+letter: ESC + the control byte).
 * Kitty: CSI <key> [:<shifted>] ; <1 + modifiers> u.
 */
export function encodeAltChord(
  event: Pick<KeyboardEvent, "code" | "shiftKey" | "ctrlKey">,
  kittyFlags: number,
): string | null {
  const base = baseKey(event.code);
  if (!base) return null;
  if (kittyFlags > 0) {
    const mods = 1 + (event.shiftKey ? 1 : 0) + 2 + (event.ctrlKey ? 4 : 0);
    const key = base.plain.codePointAt(0)!;
    const alternate = event.shiftKey && kittyFlags & KITTY_REPORT_ALTERNATES && base.shifted !== base.plain ? `:${base.shifted.codePointAt(0)}` : "";
    return `\x1b[${key}${alternate};${mods}u`;
  }
  const char = event.shiftKey ? base.shifted : base.plain;
  if (event.ctrlKey) {
    const upper = char.toUpperCase();
    if (upper >= "@" && upper <= "_") return `\x1b${String.fromCharCode(upper.charCodeAt(0) - 64)}`;
    if (char === " ") return "\x1b\x00";
    return null;
  }
  return `\x1b${char}`;
}

export interface KeyLayerOptions {
  optionAsAlt(): OptionAsAlt;
  kittyFlags(): number;
  selection(): string | null;
  copy(text: string): void;
  send(data: string): void;
  /** Every key the layer saw and what it sent, for the HUD. */
  observe?(key: string, sent: string | null): void;
}

/** Install the layer on the surface element (capture phase, before wterm). */
export function installKeyLayer(element: HTMLElement, options: KeyLayerOptions): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing) return;
    if (event.metaKey) {
      if (event.code === "KeyC" && !event.altKey && !event.ctrlKey) {
        const selected = options.selection();
        if (selected) {
          event.preventDefault();
          event.stopPropagation();
          options.copy(selected);
          options.observe?.("Cmd+C", "(copied)");
        }
      }
      return; // Cmd belongs to bb
    }
    if (event.altKey && optionApplies(options.optionAsAlt(), event.location)) {
      const bytes = encodeAltChord(event, options.kittyFlags());
      if (bytes !== null) {
        event.preventDefault();
        event.stopImmediatePropagation();
        options.send(bytes);
        options.observe?.(describe(event), bytes);
        return;
      }
    }
    options.observe?.(describe(event), null);
  };
  // wterm stops handled keys from bubbling; this catches the ones it leaves
  // (unhandled chords) so no Escape, Ctrl, Alt or F-key reaches bb's shortcuts.
  const onBubble = (event: KeyboardEvent) => {
    if (!event.metaKey) event.stopPropagation();
  };
  element.addEventListener("keydown", onKeyDown, true);
  element.addEventListener("keydown", onBubble, false);
  return () => {
    element.removeEventListener("keydown", onKeyDown, true);
    element.removeEventListener("keydown", onBubble, false);
  };
}

export function describe(event: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">): string {
  const mods = [event.ctrlKey && "Ctrl", event.altKey && "Alt", event.shiftKey && "Shift", event.metaKey && "Cmd"].filter(Boolean);
  const key = event.key === "Dead" ? `Dead(${event.code})` : event.key.length === 1 ? event.key : event.key;
  return [...mods, key].join("+");
}

/** Escape sequences as readable text for the HUD. */
export function printable(data: string): string {
  return [...data]
    .map((c) => {
      const code = c.charCodeAt(0);
      if (code === 0x1b) return "ESC ";
      if (code < 0x20) return `^${String.fromCharCode(code + 64)} `;
      if (code === 0x7f) return "DEL ";
      return c;
    })
    .join("")
    .trim();
}
