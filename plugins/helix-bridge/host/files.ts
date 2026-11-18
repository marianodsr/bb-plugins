// The file tree's file system, on the machine where the workspace is. It
// reads the folders it is asked for and nothing else (nothing recursive,
// nothing watched), and changes files only inside the workspace the server
// names: every rule of docs/HELIX_FILES.md "Safety (host)" is here. No shell:
// node:fs, and execFile with an argument array for `gio trash`.
import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { cp, lstat, mkdir, opendir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, join, normalize } from "node:path";
import type { DirListing, FileEntry, FileOp, FileOpResult } from "../app/files/types";
import { inGitDir, joinPath, nameOf, parentOf, pathError } from "../shared/files";
import { resolveExecutable } from "./doctor";

/** The most entries one folder's listing returns. */
export const LIST_LIMIT = 5000;

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/** Folders first, then files; each in natural order with case ignored (exact order breaks ties). */
export function compareEntries(a: FileEntry, b: FileEntry): number {
  if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
  return collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/** A refusal or failure, in words for the user. */
class FilesError extends Error {}

function checkRoot(root: string): string {
  if (!isAbsolute(root) || root.includes("\0")) throw new FilesError(`The workspace is not an absolute path: ${root}`);
  return normalize(root);
}

function absoluteOf(root: string, path: string): string {
  return path === "" ? root : join(root, ...path.split("/"));
}

function words(error: unknown, path: string): string {
  if (error instanceof FilesError) return error.message;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  const where = path === "" ? "the workspace" : path;
  switch (code) {
    case "ENOENT":
      return `${where} is not there`;
    case "ENOTDIR":
      return `${where}: a part of the path is not a folder`;
    case "EEXIST":
    case "ENOTEMPTY":
      return `${where} is taken`;
    case "EACCES":
    case "EPERM":
      return `No permission for ${where}`;
    case "ENOSPC":
      return "The disk is full";
    case "EROFS":
      return `${where} is on a read-only disk`;
    case "EBUSY":
      return `${where} is in use`;
    default:
      return error instanceof Error ? error.message : String(error);
  }
}

// ----- reading ------------------------------------------------------------------

function listingError(error: unknown, path: string): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOENT") return path === "" ? "The workspace is not there" : "This folder is not there any more";
  if (code === "ENOTDIR") return "This is not a folder";
  if (code === "EACCES" || code === "EPERM") return "No permission to read this folder";
  return words(error, path);
}

/** One folder: at most LIST_LIMIT entries, links followed for their kind (a broken one is a file). */
async function listOne(root: string, path: string): Promise<DirListing> {
  const refused = pathError(path, { workspace: true });
  if (refused) return { entries: [], error: refused, truncated: false };
  const dirPath = absoluteOf(root, path);
  const dirents: Dirent[] = [];
  let truncated = false;
  try {
    // Read no more than the limit: a folder of a million entries costs what one of 5 000 does.
    const dir = await opendir(dirPath, { bufferSize: 1024 });
    try {
      for (let d = await dir.read(); d; d = await dir.read()) {
        if (dirents.length === LIST_LIMIT) {
          truncated = true;
          break;
        }
        dirents.push(d);
      }
    } finally {
      await dir.close().catch(() => {});
    }
  } catch (error) {
    return { entries: [], error: listingError(error, path), truncated: false };
  }
  const entries = await Promise.all(
    dirents.map(async (d): Promise<FileEntry> => {
      if (!d.isSymbolicLink()) return { name: d.name, kind: d.isDirectory() ? "dir" : "file" };
      const target = await stat(join(dirPath, d.name)).catch(() => null);
      return { name: d.name, kind: target?.isDirectory() ? "dir" : "file", link: true };
    }),
  );
  return { entries: entries.sort(compareEntries), error: null, truncated };
}

/** Several folders in one call; every asked folder is a key of the answer. */
export async function listDirs(root: string, dirs: string[]): Promise<Record<string, DirListing>> {
  const base = checkRoot(root);
  const unique = [...new Set(dirs)];
  const listings = await Promise.all(unique.map((d) => listOne(base, d)));
  return Object.fromEntries(unique.map((d, i) => [d, listings[i]!]));
}

// ----- changing -----------------------------------------------------------------

export interface OpOptions {
  /** Where trashed entries go on macOS (default ~/.Trash); tests pass a temporary folder. */
  trashDir?: string;
  platform?: NodeJS.Platform;
  /** Finds `gio` off macOS (default: on PATH). */
  findExecutable?: (name: string) => string | null;
}

export type OpOutcome = FileOpResult & {
  /** The folders whose listing changed, for the tree to read again. */
  touched: string[];
};

function within(real: string, realRoot: string): boolean {
  return real === realRoot || real.startsWith(realRoot.endsWith("/") ? realRoot : `${realRoot}/`);
}

class Workspace {
  private realRootPromise: Promise<string> | null = null;

  constructor(readonly root: string) {}

  abs(path: string): string {
    return absoluteOf(this.root, path);
  }

  realRoot(): Promise<string> {
    this.realRootPromise ??= realpath(this.root).catch((error: unknown) => {
      throw new FilesError(listingError(error, ""));
    });
    return this.realRootPromise;
  }

  /** A path an operation may take from or write to: well formed, not the workspace, not `.git`. */
  check(path: string): void {
    const refused = pathError(path);
    if (refused) throw new FilesError(refused);
    if (inGitDir(path)) throw new FilesError(`.git is not changed from the file tree: ${path}`);
  }

  /** A folder something goes into: "" or a checked path. */
  checkFolder(path: string): void {
    if (path !== "") this.check(path);
  }

  /**
   * The real path of `folder` (or, when it does not exist yet, of its
   * nearest existing ancestor) must be inside the real workspace: a link on
   * the way may not lead out of it.
   */
  async inside(folder: string): Promise<void> {
    const realRoot = await this.realRoot();
    for (let current = folder; ; current = parentOf(current)) {
      const real = await realpath(this.abs(current)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" && current !== "") return null;
        throw new FilesError(words(error, current));
      });
      if (real === null) continue;
      if (!within(real, realRoot)) throw new FilesError(`${folder === "" ? "The workspace" : folder} leads out of the workspace`);
      return;
    }
  }

  /** An existing entry, without following a link. */
  async entry(path: string) {
    return lstat(this.abs(path)).catch((error: unknown) => {
      throw new FilesError(words(error, path));
    });
  }

  /** An existing folder to put entries into, inside the workspace. */
  async folder(path: string): Promise<void> {
    await this.inside(path);
    const info = await stat(this.abs(path)).catch((error: unknown) => {
      throw new FilesError(words(error, path));
    });
    if (!info.isDirectory()) throw new FilesError(`${path} is not a folder`);
  }
}

async function taken(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
      throw error;
    },
  );
}

/** `name`, else `name_1.ext`, `name_2.ext`, …: the first that is free in `dir` (absolute). Folders keep dots whole. */
export async function freeName(dir: string, name: string, folder: boolean): Promise<string> {
  if (!(await taken(join(dir, name)))) return name;
  const ext = folder ? "" : extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 1; i < 10_000; i += 1) {
    const candidate = `${stem}_${i}${ext}`;
    if (!(await taken(join(dir, candidate)))) return candidate;
  }
  throw new FilesError(`No free name for ${name}`);
}

/** `inner` is `outer` or under it, by real path. */
async function contains(outer: string, inner: string): Promise<boolean> {
  const [a, b] = await Promise.all([realpath(outer), realpath(inner)]);
  return within(b, a);
}

async function samePlace(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([realpath(a), realpath(b)]);
  return x === y;
}

/** Copy without following links (a link is copied as a link), never over anything. */
function copyEntry(from: string, to: string): Promise<void> {
  return cp(from, to, { recursive: true, force: false, errorOnExist: true, dereference: false, verbatimSymlinks: true });
}

async function moveEntry(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    // Another disk (a mount inside the workspace): copy, then remove.
    await copyEntry(from, to);
    await rm(from, { recursive: true, force: false });
  }
}

function gio(executable: string, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(executable, ["trash", "--", path], { timeout: 60_000 }, (error, _stdout, stderr) => {
      if (error) reject(new FilesError((stderr || error.message).trim().split("\n")[0] ?? "gio trash failed"));
      else resolve();
    });
  });
}

/** Apply one operation inside the workspace `root`. Errors come back as values. */
export async function applyOp(root: string, op: FileOp, options: OpOptions = {}): Promise<OpOutcome> {
  const paths: string[] = [];
  const touched = new Set<string>();
  let current = "";
  try {
    const ws = new Workspace(checkRoot(root));
    switch (op.kind) {
      case "create": {
        const folder = op.path.endsWith("/");
        const path = folder ? op.path.slice(0, -1) : op.path;
        current = path;
        ws.check(path);
        const parent = parentOf(path);
        // The top of what gets made: the entry, or the first folder on the way that is missing.
        let top = path;
        while (parentOf(top) !== "" && !(await taken(ws.abs(parentOf(top))))) top = parentOf(top);
        await ws.folder(parentOf(top));
        if (await taken(ws.abs(path))) throw new FilesError(`${path} is taken`);
        await mkdir(ws.abs(parent), { recursive: true });
        if (folder) await mkdir(ws.abs(path));
        else await writeFile(ws.abs(path), "", { flag: "wx" });
        for (let made = parent; made !== parentOf(top); made = parentOf(made)) touched.add(made);
        touched.add(parentOf(top));
        paths.push(path);
        break;
      }
      case "rename": {
        current = op.from;
        ws.check(op.from);
        ws.check(op.to);
        if (op.from === op.to) {
          paths.push(op.to);
          break;
        }
        await ws.inside(parentOf(op.from));
        await ws.folder(parentOf(op.to));
        const source = await ws.entry(op.from);
        if (source.isDirectory() && (op.to === op.from || op.to.startsWith(`${op.from}/`))) throw new FilesError(`${op.from} cannot go into itself`);
        const existing = await lstat(ws.abs(op.to)).catch(() => null);
        // The same entry under another case (a case-insensitive disk) is not taken.
        if (existing && !(existing.ino === source.ino && existing.dev === source.dev)) throw new FilesError(`${op.to} is taken`);
        await rename(ws.abs(op.from), ws.abs(op.to));
        touched.add(parentOf(op.from)).add(parentOf(op.to));
        paths.push(op.to);
        break;
      }
      case "copy":
      case "move": {
        ws.checkFolder(op.into);
        for (const from of op.from) ws.check(from);
        await ws.folder(op.into);
        for (const from of op.from) await ws.inside(parentOf(from));
        for (const from of op.from) {
          current = from;
          const source = await ws.entry(from);
          const isFolder = source.isDirectory();
          if (isFolder && (await contains(ws.abs(from), ws.abs(op.into)))) throw new FilesError(`${from} cannot go into itself`);
          if (op.kind === "move" && (await samePlace(ws.abs(parentOf(from)), ws.abs(op.into)))) {
            // Already in that folder: nothing to do.
            paths.push(from);
            continue;
          }
          const name = await freeName(ws.abs(op.into), nameOf(from), isFolder);
          const to = joinPath(op.into, name);
          if (op.kind === "copy") await copyEntry(ws.abs(from), ws.abs(to));
          else {
            await moveEntry(ws.abs(from), ws.abs(to));
            touched.add(parentOf(from));
          }
          touched.add(op.into);
          paths.push(to);
        }
        break;
      }
      case "trash":
      case "delete": {
        for (const path of op.paths) ws.check(path);
        for (const path of op.paths) await ws.inside(parentOf(path));
        for (const path of op.paths) await ws.entry(path);
        const platform = options.platform ?? process.platform;
        for (const path of op.paths) {
          current = path;
          const absolute = ws.abs(path);
          if (op.kind === "delete") await rm(absolute, { recursive: true, force: false });
          else if (platform === "darwin") await trashMac(absolute, path, options.trashDir ?? join(homedir(), ".Trash"));
          else {
            const executable = (options.findExecutable ?? resolveExecutable)("gio");
            if (!executable) throw new FilesError("There is no trash on this machine (gio is not installed): D deletes for good");
            await gio(executable, absolute);
          }
          touched.add(parentOf(path));
        }
        break;
      }
    }
    return { ok: true, error: null, paths, touched: [...touched] };
  } catch (error) {
    return { ok: false, error: words(error, current), paths, touched: [...touched] };
  }
}

/** macOS: a move into the Trash under a free name, on the same disk only. */
async function trashMac(absolute: string, path: string, trashDir: string): Promise<void> {
  const [source, trash] = await Promise.all([lstat(absolute), stat(trashDir).catch(() => null)]);
  if (!trash?.isDirectory()) throw new FilesError(`There is no Trash folder at ${trashDir}: D deletes for good`);
  const onOtherDisk = new FilesError(`${path} is on another disk than the Trash: D deletes it for good`);
  if (source.dev !== trash.dev) throw onOtherDisk;
  const name = await freeName(trashDir, nameOf(path), source.isDirectory());
  await rename(absolute, join(trashDir, name)).catch((error: NodeJS.ErrnoException) => {
    throw error.code === "EXDEV" ? onOtherDisk : error;
  });
}
