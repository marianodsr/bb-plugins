// Read-only git for reviews, run on the machine that has the repository:
// resolving revisions, the snapshot an agent turn starts from, and the
// changes against a base that bb's Git plugin cannot express (a snapshot).
// Nothing here moves a ref, the index or the working tree: `git stash create`
// writes a commit object for the working tree and touches nothing else.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const MAX_BUFFER = 16 * 1024 * 1024;

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-c", "core.quotepath=off", ...args], { cwd, timeout: 15_000, maxBuffer: MAX_BUFFER, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || error.message).trim().split("\n")[0] ?? "git failed"));
      else resolve(stdout);
    });
  });
}

export type GitStatus = "added" | "modified" | "deleted" | "renamed";

export interface GitFile {
  path: string;
  oldPath?: string;
  status: GitStatus;
  additions: number;
  deletions: number;
}

/** A full commit sha, or null when the repository has no such commit. */
export async function revParse(cwd: string, rev: string): Promise<string | null> {
  if (!/^[\w./~^@{}-]{1,200}$/u.test(rev) || rev.startsWith("-")) return null;
  const out = await git(cwd, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]).catch(() => "");
  const sha = out.trim();
  return /^[0-9a-f]{40}$/u.test(sha) ? sha : null;
}

export async function subject(cwd: string, sha: string): Promise<string> {
  return (await git(cwd, ["log", "-1", "--format=%s", sha]).catch(() => "")).trim();
}

export async function untracked(cwd: string): Promise<string[]> {
  return (await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
}

/**
 * The working tree as a commit (tracked changes; `git stash create`), or HEAD
 * when it is clean, with the untracked files present now.
 */
export async function snapshot(cwd: string): Promise<{ base: string | null; untracked: string[] }> {
  const stash = (await git(cwd, ["stash", "create"]).catch(() => "")).trim();
  const base = /^[0-9a-f]{40}$/u.test(stash) ? stash : await revParse(cwd, "HEAD");
  return { base, untracked: await untracked(cwd).catch(() => []) };
}

/** Files that differ between `base` and the working tree, untracked ones included (minus `exclude`). */
export async function changedFiles(cwd: string, base: string, exclude: string[] = []): Promise<GitFile[]> {
  const [numstat, names] = await Promise.all([git(cwd, ["diff", "--numstat", "-z", "-M", base, "--"]), git(cwd, ["diff", "--name-status", "-z", "-M", base, "--"])]);
  const counts = new Map<string, { additions: number; deletions: number }>();
  // numstat -z: "add\tdel\tpath\0" or, for a rename, "add\tdel\t\0old\0new\0".
  const parts = numstat.split("\0");
  for (let i = 0; i < parts.length; i += 1) {
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/u.exec(parts[i] ?? "");
    if (!match) continue;
    let path = match[3]!;
    if (path === "") {
      path = parts[i + 2] ?? "";
      i += 2;
    }
    counts.set(path, { additions: Number(match[1]) || 0, deletions: Number(match[2]) || 0 });
  }
  const files: GitFile[] = [];
  const fields = names.split("\0");
  for (let i = 0; i < fields.length; ) {
    const code = fields[i] ?? "";
    if (!code) break;
    if (code.startsWith("R") || code.startsWith("C")) {
      const oldPath = fields[i + 1] ?? "";
      const path = fields[i + 2] ?? "";
      files.push({ path, oldPath, status: code.startsWith("R") ? "renamed" : "added", ...(counts.get(path) ?? { additions: 0, deletions: 0 }) });
      i += 3;
    } else {
      const path = fields[i + 1] ?? "";
      files.push({ path, status: code === "A" ? "added" : code === "D" ? "deleted" : "modified", ...(counts.get(path) ?? { additions: 0, deletions: 0 }) });
      i += 2;
    }
  }
  const skip = new Set(exclude);
  for (const path of await untracked(cwd)) {
    if (skip.has(path)) continue;
    const text = await readFile(join(cwd, path), "utf8").catch(() => "");
    files.push({ path, status: "added", additions: text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0, deletions: 0 });
  }
  return files;
}

/** The unified diff between `base` and the working tree (tracked files). */
export async function diffText(cwd: string, base: string): Promise<string> {
  return git(cwd, ["diff", "--no-color", "--no-ext-diff", "-M", base, "--"]);
}
