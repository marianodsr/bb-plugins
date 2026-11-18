// The tree as rows: what the list draws, from the cached folders, the open
// ones and whether dot files show. Pure, so the tests and the component share it.
import type { DirListing, FileEntry } from "./types";

export type Row =
  | { type: "entry"; path: string; name: string; depth: number; kind: "file" | "dir"; link: boolean; open: boolean; hidden: boolean; match?: readonly number[] }
  /** A row that says something about a folder: loading, empty, unreadable, more than listed. */
  | { type: "note"; key: string; depth: number; tone: "loading" | "muted" | "error"; text: string }
  /** The row a new file or folder is being named in. */
  | { type: "draft"; key: "draft"; depth: number; dir: string; folder: boolean };

export const rowKey = (row: Row) => (row.type === "entry" ? row.path : row.key);

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** The host's order: folders first, then natural order with case ignored. */
export function compareEntries(a: FileEntry, b: FileEntry): number {
  if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
  return collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

export const parentOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
export const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
export const joinPath = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
/** Every folder from the workspace down to the one holding `path`: "", "a", "a/b". */
export function ancestors(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return ["", ...parts.map((_, i) => parts.slice(0, i + 1).join("/"))];
}
export const isHidden = (name: string) => name.startsWith(".");

export function flatten(dirs: ReadonlyMap<string, DirListing>, open: ReadonlySet<string>, showHidden: boolean): Row[] {
  const rows: Row[] = [];
  const root = dirs.get("");
  if (!root) return rows;
  if (root.error) {
    rows.push({ type: "note", key: "note:", depth: 0, tone: "error", text: `The workspace cannot be read: ${root.error}` });
    return rows;
  }
  const walk = (dir: string, listing: DirListing, depth: number) => {
    let shown = 0;
    for (const entry of listing.entries) {
      if (!showHidden && isHidden(entry.name)) continue;
      shown++;
      const path = joinPath(dir, entry.name);
      const isOpen = entry.kind === "dir" && open.has(path);
      rows.push({ type: "entry", path, name: entry.name, depth, kind: entry.kind, link: entry.link === true, open: isOpen, hidden: isHidden(entry.name) });
      if (!isOpen) continue;
      const child = dirs.get(path);
      if (!child) rows.push({ type: "note", key: `note:${path}`, depth: depth + 1, tone: "loading", text: "Reading" });
      else if (child.error) rows.push({ type: "note", key: `note:${path}`, depth: depth + 1, tone: "error", text: child.error });
      else walk(path, child, depth + 1);
    }
    if (shown === 0) {
      const hidden = listing.entries.length;
      rows.push({ type: "note", key: `note:${dir}`, depth, tone: "muted", text: hidden > 0 ? `Only dot files (${hidden}); press . to show them` : dir ? "Empty folder" : "The workspace is empty; press a to create a file" });
    }
    if (listing.truncated) rows.push({ type: "note", key: `more:${dir}`, depth, tone: "muted", text: `Shows the first ${listing.entries.length} entries` });
  };
  walk("", root, 0);
  return rows;
}

/**
 * The search: the query's parts (split on spaces) must appear in the name in
 * order. Smart case: a part with a capital letter matches case, otherwise
 * case is ignored. Gives the matched ranges as [start, end, start, end, …].
 */
export function matcher(query: string): ((name: string) => number[] | null) | null {
  const parts = query.trim().split(/\s+/u).filter(Boolean);
  if (parts.length === 0) return null;
  const exact = /\p{Lu}/u.test(query);
  const wanted = exact ? parts : parts.map((p) => p.toLowerCase());
  return (name) => {
    const hay = exact ? name : name.toLowerCase();
    const ranges: number[] = [];
    let from = 0;
    for (const part of wanted) {
      const at = hay.indexOf(part, from);
      if (at < 0) return null;
      ranges.push(at, at + part.length);
      from = at + part.length;
    }
    return ranges;
  };
}

/**
 * The tree narrowed to a search: every entry of the folders read so far that
 * matches, under the folders that hold it (shown open). Closed folders that
 * were read count too; folders never read are not searched.
 */
export function searchRows(dirs: ReadonlyMap<string, DirListing>, query: string, showHidden: boolean): Row[] {
  const match = matcher(query);
  const root = dirs.get("");
  if (!match || !root) return [];
  const walk = (dir: string, listing: DirListing, depth: number, out: Row[]) => {
    for (const entry of listing.entries) {
      if (!showHidden && isHidden(entry.name)) continue;
      const path = joinPath(dir, entry.name);
      const ranges = match(entry.name);
      const inside: Row[] = [];
      const child = entry.kind === "dir" ? dirs.get(path) : undefined;
      if (child && !child.error) walk(path, child, depth + 1, inside);
      if (!ranges && inside.length === 0) continue;
      out.push({ type: "entry", path, name: entry.name, depth, kind: entry.kind, link: entry.link === true, open: inside.length > 0, hidden: isHidden(entry.name), ...(ranges ? { match: ranges } : {}) });
      for (const row of inside) out.push(row);
    }
  };
  const rows: Row[] = [];
  walk("", root, 0, rows);
  if (rows.length === 0) rows.push({ type: "note", key: "note:search", depth: 0, tone: "muted", text: `Nothing matches “${query.trim()}” in the folders opened so far` });
  return rows;
}

/** A name the folder does not have yet, the host's way: `name_1.ext`, `name_2.ext`, … */
export function freeName(taken: ReadonlySet<string>, name: string): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 1; ; n++) if (!taken.has(`${stem}_${n}${ext}`)) return `${stem}_${n}${ext}`;
}

/** What is wrong with a name typed in the prompt line, relative to a folder; null when fine. */
export function badName(input: string, allowSlash: boolean): string | null {
  const value = input.endsWith("/") ? input.slice(0, -1) : input;
  if (!value.trim()) return "Type a name";
  if (value.startsWith("/")) return "Names are relative to the folder";
  if (!allowSlash && value.includes("/")) return "A name cannot have /";
  if (value.split("/").some((p) => p === "" || p === "." || p === "..")) return "A name cannot be empty, . or ..";
  if (value.includes("\0")) return "A name cannot have a NUL";
  return null;
}

/** The part of a name that rename selects: the name without its extension. */
export function stemLength(name: string): number {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? dot : name.length;
}

export function insertEntry(listing: DirListing, entry: FileEntry): DirListing {
  const entries = listing.entries.filter((e) => e.name !== entry.name);
  let at = entries.findIndex((e) => compareEntries(entry, e) < 0);
  if (at < 0) at = entries.length;
  entries.splice(at, 0, entry);
  return { ...listing, entries };
}

export function removeEntry(listing: DirListing, name: string): DirListing {
  return { ...listing, entries: listing.entries.filter((e) => e.name !== name) };
}
