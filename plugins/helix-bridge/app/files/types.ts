// The file tree's data, as the rail sees it. The tree (app/files) is written
// against FilesSource only: the real one calls the plugin's RPC (`filesList`,
// `filesOp`, `filesOpen`, shaped exactly like this in server/contract.ts), the
// preview and the tests pass one that lives in memory. Paths are relative to
// the thread's workspace, with `/` between parts; "" is the workspace itself.
// docs/HELIX_FILES.md is the design.

export interface FileEntry {
  /** The last part of the path. */
  name: string;
  /** What it is, following a link. A link that leads nowhere is a file. */
  kind: "file" | "dir";
  /** It is a symbolic link. */
  link?: boolean;
}

export interface DirListing {
  /** Folders first, then files; each in natural order (`a2` before `a10`), case ignored. Dot files included. */
  entries: FileEntry[];
  /** Why it could not be read (gone, not a folder, no permission); entries are then empty. */
  error: string | null;
  /** The folder has more entries than the host returns (5000). */
  truncated: boolean;
}

export type FileOp =
  /** A new file, or a new folder when `path` ends with `/`. Missing folders on the way are made. Never replaces. */
  | { kind: "create"; path: string }
  /** Rename or move one entry to a full new path. Never replaces. */
  | { kind: "rename"; from: string; to: string }
  /** Copy entries (folders whole) into the folder `into`. A taken name gets `_1`, `_2`, … before its extension. */
  | { kind: "copy"; from: string[]; into: string }
  /** Move entries into the folder `into`, with the same rule for taken names. */
  | { kind: "move"; from: string[]; into: string }
  /** To the system's trash. */
  | { kind: "trash"; paths: string[] }
  /** Removed for good, folders whole. */
  | { kind: "delete"; paths: string[] };

export interface FileOpResult {
  ok: boolean;
  /** What went wrong, in words for the user. With several paths, the first failure; the ones before it were done. */
  error: string | null;
  /** The entries as they are now (created, renamed to, pasted as), to put the cursor on. */
  paths: string[];
}

export interface FilesSource {
  /** Several folders in one round trip. Every asked folder is a key of the answer. */
  list(dirs: string[]): Promise<Record<string, DirListing>>;
  op(op: FileOp): Promise<FileOpResult>;
  /** Open a file in the thread's Helix. */
  open(path: string): Promise<void>;
  /** Something outside the tree changed files (the agent, Helix, a shell): the given folders, or null for "anything". Returns the unsubscribe. */
  onChanged(listener: (dirs: string[] | null) => void): () => void;
}
