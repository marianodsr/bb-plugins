// Values shared by the server and the frontend. Pure (no zod), so importing
// them never pulls the validators into the app bundle.

export const SEVERITIES = ["note", "suggestion", "issue", "blocker"] as const;
export const COMMENT_STATES = ["open", "sent", "resolved", "outdated"] as const;

/** Is this a safe workspace-relative path (no `..`, not absolute, no NUL)? */
export function isRelativePath(path: string): boolean {
  if (path === "" || path.length > 4096 || path.includes("\0")) return false;
  if (path.startsWith("/") || path.includes("\\") || /^[A-Za-z]:/u.test(path)) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}
