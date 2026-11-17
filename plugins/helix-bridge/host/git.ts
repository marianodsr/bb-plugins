// Read-only git for reviews, run on the machine that has the repository, and
// only for what the owner starts: resolving a revision, a commit's subject,
// and the recent commits the rail offers when the Commit scope opens. Files,
// diffs and viewed marks come from bb's Git plugin.
import { execFile } from "node:child_process";

const MAX_BUFFER = 1024 * 1024;

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-c", "core.quotepath=off", ...args], { cwd, timeout: 15_000, maxBuffer: MAX_BUFFER, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || error.message).trim().split("\n")[0] ?? "git failed"));
      else resolve(stdout);
    });
  });
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

/** The last commits on HEAD, newest first: sha, subject, relative date. */
export async function recentCommits(cwd: string, count = 20): Promise<{ sha: string; subject: string; when: string }[]> {
  const out = await git(cwd, ["log", `-${Math.min(50, Math.max(1, count))}`, "--format=%H%x09%cr%x09%s"]).catch(() => "");
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha = "", when = "", ...rest] = line.split("\t");
      return { sha, when, subject: rest.join("\t") };
    })
    .filter((c) => /^[0-9a-f]{40}$/u.test(c.sha));
}
