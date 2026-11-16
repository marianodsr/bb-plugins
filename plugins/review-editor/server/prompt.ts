// The prompt that hands review comments to an agent. It must stand on its
// own: the agent may have no other context about the editor or the plugin.
import type { Comment } from "./contract";

export interface PromptWorkspace {
  environmentId: string;
  /** Absolute workspace root on its host, when known. */
  root: string | null;
  branch: string | null;
}

const LANGUAGES: Record<string, string> = {
  ts: "ts", tsx: "tsx", js: "js", jsx: "jsx", mjs: "js", cjs: "js", json: "json",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin",
  swift: "swift", c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", cs: "csharp",
  php: "php", sh: "sh", bash: "bash", zsh: "zsh", css: "css", scss: "scss",
  html: "html", vue: "vue", svelte: "svelte", md: "md", yml: "yaml", yaml: "yaml",
  toml: "toml", sql: "sql", xml: "xml",
};

export function languageFor(path: string): string {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return path.includes(".") ? (LANGUAGES[extension] ?? "") : "";
}

/** A fence longer than any backtick run inside the text. */
function fenceFor(text: string): string {
  let longest = 0;
  for (const match of text.matchAll(/`+/gu)) longest = Math.max(longest, match[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}

function lineLabel(comment: Comment): string {
  return comment.startLine === comment.endLine
    ? `line ${comment.startLine}`
    : `lines ${comment.startLine}-${comment.endLine}`;
}

function numbered(comment: Comment): string {
  const lines = comment.snippet.split("\n");
  const width = String(comment.startLine + lines.length - 1).length;
  return lines
    .map((line, index) => `${String(comment.startLine + index).padStart(width)}  ${line}`)
    .join("\n");
}

/** Quote untrusted text as a Markdown block quote so it cannot end the section. */
function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");
}

export function compilePrompt(comments: readonly Comment[], workspaces: readonly PromptWorkspace[]): string {
  const byWorkspace = new Map<string, Map<string, Comment[]>>();
  for (const comment of comments) {
    const files = byWorkspace.get(comment.environmentId) ?? new Map<string, Comment[]>();
    const list = files.get(comment.path) ?? [];
    list.push(comment);
    files.set(comment.path, list);
    byWorkspace.set(comment.environmentId, files);
  }
  const fileCount = [...byWorkspace.values()].reduce((sum, files) => sum + files.size, 0);
  const noun = comments.length === 1 ? "comment" : "comments";
  const fileNoun = fileCount === 1 ? "file" : "files";

  const out: string[] = [];
  out.push(`# Code review: ${comments.length} ${noun} in ${fileCount} ${fileNoun}`);
  out.push("");
  out.push(
    "These comments were written in Review Editor on specific lines of code. Address each one: " +
      "change the code, or explain why not. Then reply and resolve it so the reviewer sees the outcome next to the code.",
  );
  out.push("");
  out.push("For each comment, by its id:");
  out.push("1. Make the change, or decide it should not be made.");
  out.push("2. Reply with what you did: `review_reply` with `{ commentId, body }`.");
  out.push(
    "3. Resolve it once it is handled: `review_resolve` with `{ commentId, note? }`. " +
      "Leave it open and reply with a question if you need the reviewer's input.",
  );
  out.push(
    "`review_list_comments` lists the comments sent to this thread with their current lines and state.",
  );
  out.push(
    "If those tools are not available, use the CLI instead: " +
      '`bb review reply <id> --body "..."`, `bb review resolve <id> [--note "..."]`, `bb review comments --thread "$BB_THREAD_ID"`.',
  );
  out.push("");
  out.push(
    "Paths are relative to the workspace root. Line numbers are from when the comment was last anchored; " +
      "if they drift, find the quoted code.",
  );

  for (const [environmentId, files] of byWorkspace) {
    const workspace = workspaces.find((candidate) => candidate.environmentId === environmentId);
    out.push("");
    const details = [`environment \`${environmentId}\``];
    if (workspace?.branch) details.push(`branch \`${workspace.branch}\``);
    out.push(
      workspace?.root
        ? `Workspace: \`${workspace.root}\` (${details.join(", ")})`
        : `Workspace: ${details.join(", ")}`,
    );
    for (const [path, list] of files) {
      out.push("");
      out.push(`## \`${path}\``);
      for (const comment of list) {
        out.push("");
        const severity = comment.severity === "note" ? "" : `, ${comment.severity}`;
        out.push(`### Comment \`${comment.id}\` on ${lineLabel(comment)}${severity}`);
        if (comment.state === "outdated") {
          out.push("");
          out.push(
            "This code has since changed and no longer appears in the file as quoted. " +
              "Check whether the comment still applies before acting on it.",
          );
        }
        const code = numbered(comment);
        const fence = fenceFor(code);
        out.push("");
        out.push(`${fence}${languageFor(path)}`);
        out.push(code);
        out.push(fence);
        out.push("");
        out.push(quote(comment.body));
        for (const reply of comment.replies) {
          out.push("");
          out.push(`Earlier reply from ${reply.author === "agent" ? "an agent" : "the reviewer"}:`);
          out.push(quote(reply.body));
        }
      }
    }
  }
  return out.join("\n");
}
