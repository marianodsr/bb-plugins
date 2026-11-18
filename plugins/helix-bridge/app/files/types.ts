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

// What only a tree inside bb can do: talk to the thread's agent about the
// entries (docs/HELIX_FILES.md, "The tree and the agent"). Everything here
// happens because the user asked for it on a row; nothing reaches the agent's
// context otherwise.

/** A file the agent changed, in the turn that is running or in the one before. */
export interface AgentFile {
  path: string;
  change: "edited" | "created" | "deleted";
  turn: "running" | "last";
}

export interface AgentFiles {
  /** A turn is running in the thread now. */
  running: boolean;
  files: AgentFile[];
}

export interface Sent {
  ok: boolean;
  /** Why it could not be sent, in words for the user. */
  error: string | null;
}

export interface ThreadLink {
  /** The thread the tree belongs to, for "Sent to …". */
  thread: { id: string; title: string | null };
  /** Put references to these entries in the thread's composer and give it the keyboard; the user writes the rest. */
  mention(paths: string[]): Promise<Sent>;
  /** Send the thread a message about these entries now (RPC `filesAsk`, kind "ask"). */
  ask(paths: string[], text: string): Promise<Sent>;
  /** Ask the thread to write a file that does not exist yet (RPC `filesAsk`, kind "write"). */
  write(path: string, description: string): Promise<Sent>;
  /** The agent's files (RPC `agentFiles`). */
  agentFiles(): Promise<AgentFiles>;
  /** They changed (realtime `agent-files`). Returns the unsubscribe. */
  onAgentFiles(listener: () => void): () => void;
  /** Open bb's new-thread screen with these entries referenced. Absent when bb offers no way. */
  newThread?(paths: string[]): void;
}
