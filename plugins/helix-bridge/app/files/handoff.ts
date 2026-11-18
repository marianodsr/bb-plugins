// What the tree and bb's composers share without either importing the other:
// where a handoff lands on screen, the rows being dragged out of the tree, and
// how entries become bb's mentions.
import type { ComposerInsertPart } from "@get-bb/plugin-sdk/app";

/** Where a handoff to the thread lands on screen: its composer, else the rail's thread chip. */
export function composerElement(threadId: string): Element | null {
  const composers = Array.from(document.querySelectorAll<HTMLElement>("[contenteditable='true']")).filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.right > 0 && r.left < window.innerWidth;
  });
  return composers.find((el) => !el.closest("[data-helix-rail], [data-files-tree]")) ?? document.querySelector(`[data-kit-thread-chip="${CSS.escape(threadId)}"]`);
}

export function store<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: T) {
      value = next;
      for (const l of listeners) l();
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
  };
}

/** Rows being dragged out of the tree (a folder with a trailing `/`), set on dragstart and cleared on dragend. */
export const draggedRows = store<string[] | null>(null);
/** The drag's data type; no text/plain, so a drop elsewhere does not paste the paths as text. */
export const DRAG_TYPE = "application/x-helix-files";

/**
 * Paths as the tree gives them to `mention` and `newThread`: relative to the
 * workspace, a folder with a trailing `/` (the contract's `paths` has no
 * kinds, and bb's mention needs to know).
 */
export function mentionParts(paths: readonly string[]): ComposerInsertPart[] {
  const parts: ComposerInsertPart[] = [];
  for (const raw of paths) {
    const dir = raw.endsWith("/");
    const path = dir ? raw.slice(0, -1) : raw;
    parts.push({ from: 0, to: 0, label: path, kind: "path", path, source: "workspace", entryKind: dir ? "directory" : "file" }, " ");
  }
  return parts;
}

