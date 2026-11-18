// The file tree's path rule, the same at both ends: a path is relative to the
// thread's workspace, with `/` between parts; "" is the workspace itself.
// docs/HELIX_FILES.md "Safety (host)".

/** Why a workspace-relative path is refused, or null. "" (the workspace) passes only with `workspace`. */
export function pathError(path: string, options: { workspace?: boolean } = {}): string | null {
  if (path === "") return options.workspace ? null : "The workspace itself cannot be changed";
  if (path.includes("\0")) return "A path cannot contain a NUL character";
  if (path.startsWith("/")) return `Not a path in the workspace: ${path}`;
  for (const part of path.split("/")) {
    if (part === "") return `A path cannot have an empty part: ${path}`;
    if (part === "." || part === "..") return `A path cannot have a "${part}" part: ${path}`;
  }
  return null;
}

/** It is `.git` or under it, at any depth (a submodule's too), in any case. */
export function inGitDir(path: string): boolean {
  return path.split("/").some((part) => part.toLowerCase() === ".git");
}

/** The folder that holds `path`; "" for an entry of the workspace. */
export function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/** The last part of `path`. */
export function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function joinPath(dir: string, name: string): string {
  return dir === "" ? name : `${dir}/${name}`;
}
