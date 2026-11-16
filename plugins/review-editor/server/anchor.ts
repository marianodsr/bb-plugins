// Comment anchoring: keep a comment on the code it was written about while the
// file changes underneath it.
//
// A comment stores its line range, the quoted snippet and the sha256 of the
// file it was anchored against. When the file changes we look for the snippet
// again, in this order:
//
//   1. tracked: when the previous content is known, a line diff maps the old
//      range to the new file. If every quoted line survived and is still
//      contiguous, that is the answer, even with duplicates elsewhere.
//   2. exact: the snippet's lines appear verbatim; nearest match wins.
//   3. whitespace-insensitive: the snippet with all whitespace removed equals
//      a run of lines with all whitespace removed (reindents, reflowed lines,
//      blank lines added inside); nearest match wins.
//   4. otherwise the comment is outdated and keeps its old snippet.
//
// When the previous content is known, steps 2 and 3 skip matches made only of
// lines that already existed elsewhere before the change: those are another
// copy of the same code, and a comment whose own copy was edited or deleted
// goes outdated instead of jumping onto it.
//
// "Nearest" is measured from where the old start line lands in the new file
// (projected through the diff when the previous content is known, otherwise
// the old line number itself).
import { diffArrays } from "diff";

export interface Anchor {
  /** One-based, inclusive. */
  startLine: number;
  /** One-based, inclusive. */
  endLine: number;
  /** The quoted lines, joined with "\n". */
  snippet: string;
}

export type AnchorMatch = "unchanged" | "tracked" | "exact" | "whitespace";

export type AnchorResult =
  | ({ status: "found"; match: AnchorMatch } & Anchor)
  | { status: "outdated" };

/** Diffs bigger than this give up on tracking and fall back to searching. */
const MAX_EDIT_LENGTH = 2_000;

/** Split file content into lines. A trailing newline does not add a line. */
export function splitLines(content: string): string[] {
  if (content === "") return [];
  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

/** The snippet for a one-based inclusive range, or null when out of bounds. */
export function snippetFor(
  lines: readonly string[],
  startLine: number,
  endLine: number,
): string | null {
  if (startLine < 1 || endLine < startLine || endLine > lines.length) return null;
  return lines.slice(startLine - 1, endLine).join("\n");
}

function stripWhitespace(text: string): string {
  return text.replace(/\s+/gu, "");
}

/**
 * Map each old line index to the new index it now occupies (`kept`), and
 * each old index to where it would sit in the new file (`projected`), so a
 * deleted or edited line still has a position to measure distance from.
 */
function trackLines(
  oldLines: readonly string[],
  newLines: readonly string[],
): { kept: Map<number, number>; keptFrom: Map<number, number>; projected: number[] } | null {
  const parts = diffArrays(oldLines as string[], newLines as string[], {
    maxEditLength: MAX_EDIT_LENGTH,
  });
  if (parts === undefined) return null;
  const kept = new Map<number, number>();
  const keptFrom = new Map<number, number>();
  const projected: number[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  for (const part of parts) {
    const count = part.count ?? part.value.length;
    if (part.added) {
      newIndex += count;
    } else if (part.removed) {
      for (let i = 0; i < count; i += 1) projected[oldIndex + i] = newIndex;
      oldIndex += count;
    } else {
      for (let i = 0; i < count; i += 1) {
        kept.set(oldIndex + i, newIndex + i);
        keptFrom.set(newIndex + i, oldIndex + i);
        projected[oldIndex + i] = newIndex + i;
      }
      oldIndex += count;
      newIndex += count;
    }
  }
  return { kept, keptFrom, projected };
}

/** Pick the candidate start index closest to `expected`; ties go to the earlier one. */
function nearest<T extends { start: number }>(candidates: readonly T[], expected: number): T | null {
  let best: T | null = null;
  for (const candidate of candidates) {
    if (
      best === null ||
      Math.abs(candidate.start - expected) < Math.abs(best.start - expected)
    ) {
      best = candidate;
    }
  }
  return best;
}

function exactMatches(lines: readonly string[], snippetLines: readonly string[]) {
  const matches: { start: number; end: number }[] = [];
  const size = snippetLines.length;
  for (let start = 0; start + size <= lines.length; start += 1) {
    let equal = true;
    for (let offset = 0; offset < size; offset += 1) {
      if (lines[start + offset] !== snippetLines[offset]) {
        equal = false;
        break;
      }
    }
    if (equal) matches.push({ start, end: start + size - 1 });
  }
  return matches;
}

function whitespaceMatches(lines: readonly string[], snippetLines: readonly string[]) {
  const target = stripWhitespace(snippetLines.join(""));
  const matches: { start: number; end: number }[] = [];
  if (target === "") return matches;
  const stripped = lines.map(stripWhitespace);
  for (let start = 0; start < lines.length; start += 1) {
    const first = stripped[start]!;
    // A match starts on a line with content, so ranges never gain leading blanks.
    if (first === "" || !target.startsWith(first)) continue;
    let accumulated = first;
    let end = start;
    while (accumulated.length < target.length && end + 1 < lines.length) {
      end += 1;
      accumulated += stripped[end]!;
      if (!target.startsWith(accumulated)) break;
    }
    if (accumulated === target) matches.push({ start, end });
  }
  return matches;
}

/**
 * Find `anchor` in `content`. `previousContent` is the file the anchor was
 * computed against, when it is still known; it makes tracking exact.
 */
export function reanchor(
  anchor: Anchor,
  content: string,
  previousContent: string | null = null,
): AnchorResult {
  const lines = splitLines(content);
  const snippetLines = anchor.snippet.split("\n");
  const oldStart = anchor.startLine - 1;
  let expected = oldStart;
  // With tracking, a match made only of lines that were already there, at
  // another place, is a different copy of the same code: never jump onto it.
  let isOtherCopy = (_match: { start: number; end: number }) => false;

  if (previousContent !== null) {
    const oldLines = splitLines(previousContent);
    const tracking = trackLines(oldLines, lines);
    if (tracking !== null) {
      const { kept, projected } = tracking;
      const first = kept.get(oldStart);
      let contiguous = first !== undefined;
      for (let i = oldStart; contiguous && i <= anchor.endLine - 1; i += 1) {
        if (kept.get(i) !== first! + (i - oldStart)) contiguous = false;
      }
      // The old snapshot can disagree with the stored snippet if it was
      // anchored loosely; only trust tracking when the text still matches.
      const span = first === undefined ? null : snippetFor(lines, first + 1, first + snippetLines.length);
      if (contiguous && span === anchor.snippet) {
        const startLine = first! + 1;
        return {
          status: "found",
          match: startLine === anchor.startLine ? "unchanged" : "tracked",
          startLine,
          endLine: startLine + snippetLines.length - 1,
          snippet: anchor.snippet,
        };
      }
      expected = projected[oldStart] ?? lines.length;
      isOtherCopy = ({ start, end }) => {
        for (let i = start; i <= end; i += 1) {
          const from = tracking.keptFrom.get(i);
          if (from === undefined || (from >= oldStart && from <= anchor.endLine - 1)) return false;
        }
        return true;
      };
    }
  }

  const exact = nearest(exactMatches(lines, snippetLines).filter((match) => !isOtherCopy(match)), expected);
  if (exact !== null) {
    const startLine = exact.start + 1;
    return {
      status: "found",
      match: startLine === anchor.startLine ? "unchanged" : "exact",
      startLine,
      endLine: exact.end + 1,
      snippet: anchor.snippet,
    };
  }

  const loose = nearest(whitespaceMatches(lines, snippetLines).filter((match) => !isOtherCopy(match)), expected);
  if (loose !== null) {
    return {
      status: "found",
      match: "whitespace",
      startLine: loose.start + 1,
      endLine: loose.end + 1,
      snippet: lines.slice(loose.start, loose.end + 1).join("\n"),
    };
  }

  return { status: "outdated" };
}
