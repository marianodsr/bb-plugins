// GENERATED from /kit by kit/scripts/sync.mjs (kit 36f976388355). Do not edit; change /kit and re-sync.
import { useEffect, useRef, useSyncExternalStore, type RefObject } from "react";

/**
 * A key binding. `key` is a combo such as `"j"`, `"?"`, `"shift+n"`,
 * `"mod+k"` (Cmd on macOS, Ctrl elsewhere), `"Escape"`, `"ArrowDown"`, `"["`.
 * Several combos for one action: `["j", "ArrowDown"]`.
 */
export interface Hotkey {
  key: string | readonly string[];
  handler: (event: KeyboardEvent) => void;
  /** Shown in the `?` sheet. Bindings without one stay out of the sheet. */
  description?: string;
  /** Sheet section, e.g. "Navigation". Defaults to "General". */
  group?: string;
  /** Default true. A disabled binding neither fires nor shows. */
  enabled?: boolean;
  /** Fire while typing in an input or editor. Default false (Escape: true). */
  allowInInputs?: boolean;
  /** Default true: the handled event gets preventDefault(). */
  preventDefault?: boolean;
}

export interface UseHotkeysOptions {
  /**
   * Only fire when focus is inside this element, or when nothing is focused
   * (focus on `<body>`) and the element is in the document. Omit for a
   * page-wide binding.
   */
  scope?: RefObject<HTMLElement | null>;
  enabled?: boolean;
}

const isMac =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

interface Combo {
  key: string;
  mod: boolean;
  shift: boolean | null; // null: do not care (punctuation like "?")
  alt: boolean;
}

function parseCombo(combo: string): Combo {
  const parts = combo === "+" ? ["+"] : combo.split("+");
  const raw = parts[parts.length - 1] ?? "";
  const mods = new Set(parts.slice(0, -1).map((p) => p.toLowerCase()));
  const key = raw.length === 1 ? raw.toLowerCase() : raw;
  const isLetter = /^[a-z]$/.test(key);
  const isNamed = raw.length > 1;
  return {
    key,
    mod: mods.has("mod") || mods.has("meta") || mods.has("ctrl"),
    shift: mods.has("shift") ? true : isLetter || isNamed ? false : null,
    alt: mods.has("alt") || mods.has("option"),
  };
}

function matches(combo: Combo, event: KeyboardEvent): boolean {
  const eventKey = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  const key = combo.key === "space" || combo.key === "Space" ? " " : combo.key;
  if (eventKey !== key) return false;
  const mod = isMac ? event.metaKey : event.ctrlKey;
  if (mod !== combo.mod) return false;
  if (!combo.mod && (event.metaKey || event.ctrlKey)) return false;
  if (event.altKey !== combo.alt) return false;
  if (combo.shift !== null && event.shiftKey !== combo.shift) return false;
  return true;
}

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (target as HTMLInputElement).type;
    return !["checkbox", "radio", "button", "submit", "reset", "range", "color"].includes(type);
  }
  return target.closest('[role="textbox"], [contenteditable="true"]') !== null;
}

/** Human label for a combo: `mod+k` becomes `⌘K` on macOS, `Ctrl+K` elsewhere. */
export function formatCombo(combo: string): string[] {
  const parts = combo === "+" ? ["+"] : combo.split("+");
  const names: Record<string, string> = {
    mod: isMac ? "⌘" : "Ctrl",
    meta: isMac ? "⌘" : "Win",
    ctrl: "Ctrl",
    shift: isMac ? "⇧" : "Shift",
    alt: isMac ? "⌥" : "Alt",
    option: "⌥",
    escape: "Esc",
    enter: "Enter",
    space: "Space",
    " ": "Space",
    arrowup: "↑",
    arrowdown: "↓",
    arrowleft: "←",
    arrowright: "→",
    backspace: "⌫",
    tab: "Tab",
  };
  return parts.map((p) => names[p.toLowerCase()] ?? (p.length === 1 ? p.toUpperCase() : p));
}

// Registry of described bindings, read by ShortcutSheet.
export interface RegisteredHotkey {
  id: number;
  keys: readonly string[];
  description: string;
  group: string;
}

let registry: RegisteredHotkey[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function setRegistry(next: RegisteredHotkey[]) {
  registry = next;
  emit();
}

export function useRegisteredHotkeys(): readonly RegisteredHotkey[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => registry,
    () => registry,
  );
}

let nextId = 1;

/**
 * Scoped keyboard shortcuts that ignore typing in inputs and editors.
 *
 * ```tsx
 * useHotkeys([
 *   { key: ["j", "ArrowDown"], handler: next, description: "Next issue", group: "Navigation" },
 *   { key: "/", handler: focusSearch, description: "Search" },
 * ], { scope: pageRef });
 * ```
 */
export function useHotkeys(hotkeys: readonly Hotkey[], options: UseHotkeysOptions = {}) {
  const latest = useRef(hotkeys);
  latest.current = hotkeys;
  const { scope, enabled = true } = options;

  // Registration for the sheet follows the described, enabled bindings.
  const signature = hotkeys
    .filter((h) => h.description && h.enabled !== false)
    .map((h) => `${[h.key].flat().join(",")}:${h.description}:${h.group ?? ""}`)
    .join("|");

  useEffect(() => {
    if (!enabled || signature === "") return;
    const entries: RegisteredHotkey[] = latest.current
      .filter((h) => h.description && h.enabled !== false)
      .map((h) => ({
        id: nextId++,
        keys: [h.key].flat(),
        description: h.description!,
        group: h.group ?? "General",
      }));
    setRegistry([...registry, ...entries]);
    return () => {
      const ids = new Set(entries.map((e) => e.id));
      setRegistry(registry.filter((e) => !ids.has(e.id)));
    };
  }, [enabled, signature]);

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (scope) {
        const root = scope.current;
        if (!root || !root.isConnected) return;
        const active = document.activeElement;
        const inside = active !== null && root.contains(active);
        const idle = active === null || active === document.body;
        if (!inside && !idle) return;
      }
      const typing = isTypingTarget(event.target);
      for (const hotkey of latest.current) {
        if (hotkey.enabled === false) continue;
        for (const combo of [hotkey.key].flat()) {
          const parsed = parseCombo(combo);
          if (!matches(parsed, event)) continue;
          const allowTyping = hotkey.allowInInputs ?? parsed.key === "Escape";
          if (typing && !allowTyping) continue;
          if (hotkey.preventDefault !== false) event.preventDefault();
          hotkey.handler(event);
          return;
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [enabled, scope]);
}
