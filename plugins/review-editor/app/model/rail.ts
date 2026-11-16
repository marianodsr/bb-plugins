// Margin rail layout: each note wants to sit level with the first line of its
// range. Notes never overlap; the active note keeps its exact position and
// the others make room above and below it.

export interface RailItem {
  id: string;
  /** The y of the note's anchor line, relative to the rail. */
  anchor: number;
  /** Measured height; 0 until measured. */
  height: number;
}

export const RAIL_GAP = 8;

/** Top offset for every item, keyed by id. Items are ordered by anchor (ties keep input order). */
export function layoutRail(items: readonly RailItem[], activeId: string | null, gap = RAIL_GAP): Map<string, number> {
  const sorted = items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => a.item.anchor - b.item.anchor || a.index - b.index)
    .map(({ item }) => item);
  const tops = new Map<string, number>();
  if (sorted.length === 0) return tops;

  const pivot = Math.max(0, activeId === null ? -1 : sorted.findIndex((item) => item.id === activeId));
  const anchorAt = activeId === null || sorted[pivot]!.id !== activeId ? null : sorted[pivot]!.anchor;

  const packDown = () => {
    let floor = 0;
    for (const item of sorted) {
      const top = Math.max(item.anchor, floor);
      tops.set(item.id, top);
      floor = top + item.height + gap;
    }
    return tops;
  };
  // No active note: pack downward from the top.
  if (anchorAt === null) return packDown();

  tops.set(sorted[pivot]!.id, anchorAt);
  // Below the active note: push down.
  let floor = anchorAt + sorted[pivot]!.height + gap;
  for (let i = pivot + 1; i < sorted.length; i += 1) {
    const top = Math.max(sorted[i]!.anchor, floor);
    tops.set(sorted[i]!.id, top);
    floor = top + sorted[i]!.height + gap;
  }
  // Above the active note: push up, never past its own anchor going down.
  let ceiling = anchorAt - gap;
  for (let i = pivot - 1; i >= 0; i -= 1) {
    const top = Math.min(sorted[i]!.anchor, ceiling - sorted[i]!.height);
    tops.set(sorted[i]!.id, top);
    ceiling = top - gap;
  }
  // Not enough room above the active note: fall back to packing downward.
  if (pivot > 0 && tops.get(sorted[0]!.id)! < 0) return packDown();
  return tops;
}
