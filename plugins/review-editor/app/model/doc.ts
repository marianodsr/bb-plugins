// The editor's view of one file on disk: what it last loaded or saved, whether
// the buffer has diverged, and what to do when the disk moves on. Pure, so
// every branch is testable without CodeMirror.

export interface DiskFile {
  sha256: string;
  content: string;
}

export interface DocState {
  /** The disk version the buffer is based on (last load or save). */
  base: DiskFile | null;
  /** The buffer differs from `base.content`. */
  dirty: boolean;
  saving: boolean;
  /** A save was refused: the disk holds this sha (null: the file was deleted). */
  conflict: { currentSha256: string | null } | null;
  /** The disk changed while the buffer was dirty; waiting for the user. */
  external: DiskFile | null;
}

export const initialDoc: DocState = { base: null, dirty: false, saving: false, conflict: null, external: null };

export type DocAction =
  | { type: "loaded"; file: DiskFile }
  | { type: "edited"; content: string }
  | { type: "save-started" }
  | { type: "saved"; sha256: string; content: string; bufferContent: string }
  | { type: "save-conflict"; currentSha256: string | null }
  | { type: "save-failed" }
  /** The disk changed under a dirty buffer: hold it until the user chooses. */
  | { type: "external"; file: DiskFile }
  /** The user chose the disk version: the buffer is replaced with `file`. */
  | { type: "took-disk"; file: DiskFile }
  /** The user keeps their buffer; the next save overwrites the disk `file`. */
  | { type: "kept-mine"; file: DiskFile; bufferContent: string };

export function docReducer(state: DocState, action: DocAction): DocState {
  switch (action.type) {
    case "loaded":
      return { ...initialDoc, base: action.file };
    case "edited": {
      const dirty = state.base === null ? action.content !== "" : action.content !== state.base.content;
      return dirty === state.dirty ? state : { ...state, dirty };
    }
    case "save-started":
      return { ...state, saving: true };
    case "saved":
      return {
        ...state,
        saving: false,
        conflict: null,
        external: null,
        base: { sha256: action.sha256, content: action.content },
        // Typing during the save keeps the buffer dirty.
        dirty: action.bufferContent !== action.content,
      };
    case "save-conflict":
      return { ...state, saving: false, conflict: { currentSha256: action.currentSha256 } };
    case "save-failed":
      return { ...state, saving: false };
    case "external":
      return { ...state, external: action.file };
    case "took-disk":
      return { ...initialDoc, base: action.file };
    case "kept-mine":
      // Rebase onto the disk sha so the next save goes through; the buffer
      // stays dirty because it no longer matches what is on disk.
      return {
        ...state,
        conflict: null,
        external: null,
        base: action.file,
        dirty: action.bufferContent !== action.file.content,
      };
  }
}

export type DiskReconcile =
  /** Same version, or the echo of our own save. */
  | { effect: "none" }
  /** Clean buffer: replace it in place with the new content. */
  | { effect: "replace"; file: DiskFile }
  /** Dirty buffer: tell the user and let them choose. */
  | { effect: "ask"; file: DiskFile };

/** What to do when a fresh read of the file arrives. */
export function reconcileDisk(state: DocState, file: DiskFile): DiskReconcile {
  if (state.base === null) return { effect: "replace", file };
  if (file.sha256 === state.base.sha256) return { effect: "none" };
  if (state.external?.sha256 === file.sha256) return { effect: "none" };
  if (state.saving) return { effect: "none" };
  return state.dirty ? { effect: "ask", file } : { effect: "replace", file };
}
