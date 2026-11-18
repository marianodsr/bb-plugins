// A FilesSource that lives in memory, for the `~files` preview and the tests:
// a workspace whose operations really change it, with the host's rules (never
// replace, `_1` for a taken name on paste, the root and `.git` stay, at most
// 5000 entries listed) and a small latency per call so loading can be seen.
import { compareEntries } from "./model";
import type { DirListing, FileEntry, FileOp, FileOpResult, FilesSource } from "./types";

type Node = { kind: "file" } | { kind: "dir"; children: Map<string, Node>; error?: string } | { kind: "link"; to: Node };

export const LIST_LIMIT = 5000;

const dir = (entries: Record<string, Node> = {}, error?: string): Node => ({ kind: "dir", children: new Map(Object.entries(entries)), ...(error ? { error } : {}) });
const file = (): Node => ({ kind: "file" });

export interface MemorySource extends FilesSource {
  /** Every call so far, for the tests: `list` with its folders, `op` with its kind. */
  calls: { method: "list" | "op" | "open"; dirs?: string[]; op?: FileOp; path?: string }[];
  /** A change from outside the tree (the agent): applied, then announced. */
  external(change: FileOp, announce?: string[] | null): void;
  /** The next operation of this kind fails with this error (the host refusing). */
  failNext(kind: FileOp["kind"], error: string): void;
  exists(path: string): boolean;
  latency: number;
}

export interface MemoryWorkspace {
  [name: string]: MemoryWorkspace | null | { link: string } | { error: string };
}

/**
 * `spec`: a folder is an object, a file is null, `{ link: "a/b" }` is a link
 * to another path of the workspace, `{ error }` is a folder that cannot be read.
 */
export function memorySource(spec: MemoryWorkspace, options: { latency?: number } = {}): MemorySource {
  const root = dir();
  const links: [Map<string, Node>, string, string][] = [];
  const build = (into: Map<string, Node>, s: MemoryWorkspace) => {
    for (const [name, value] of Object.entries(s)) {
      if (value === null) into.set(name, file());
      else if ("link" in value && typeof value.link === "string") links.push([into, name, value.link]);
      else if ("error" in value && typeof value.error === "string") into.set(name, dir({}, value.error));
      else {
        const d = dir();
        into.set(name, d);
        build((d as { children: Map<string, Node> }).children, value as MemoryWorkspace);
      }
    }
  };
  build((root as { children: Map<string, Node> }).children, spec);
  for (const [into, name, to] of links) into.set(name, { kind: "link", to: find(to) ?? file() });

  const listeners = new Set<(dirs: string[] | null) => void>();
  const failures = new Map<FileOp["kind"], string>();
  const calls: MemorySource["calls"] = [];

  function real(node: Node): Node {
    return node.kind === "link" ? node.to : node;
  }
  function find(path: string): Node | null {
    let node: Node = root;
    if (path === "") return root;
    for (const part of path.split("/")) {
      const r = real(node);
      if (r.kind !== "dir") return null;
      const next = r.children.get(part);
      if (!next) return null;
      node = next;
    }
    return node;
  }
  const parentOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
  const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
  const join = (a: string, b: string) => (a ? `${a}/${b}` : b);
  function checkPath(path: string): string | null {
    if (path.startsWith("/") || path.split("/").some((p) => p === "" || p === "." || p === "..") || path.includes("\0")) return `${path} is not a path in the workspace`;
    return null;
  }
  function guarded(path: string): string | null {
    if (path === "") return "The workspace itself cannot be changed";
    if (path === ".git" || path.startsWith(".git/")) return ".git is left alone";
    return checkPath(path);
  }
  function freeName(into: Map<string, Node>, name: string): string {
    if (!into.has(name)) return name;
    const dot = name.lastIndexOf(".");
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
    for (let n = 1; ; n++) if (!into.has(`${stem}_${n}${ext}`)) return `${stem}_${n}${ext}`;
  }
  function clone(node: Node): Node {
    if (node.kind === "file") return file();
    if (node.kind === "link") return { kind: "link", to: node.to };
    return { kind: "dir", children: new Map([...node.children].map(([k, v]) => [k, clone(v)])), ...(node.error ? { error: node.error } : {}) };
  }
  function dirNode(path: string): Map<string, Node> | string {
    const node = find(path);
    if (!node) return `${path || "The workspace"} is gone`;
    const r = real(node);
    if (r.kind !== "dir") return `${path} is not a folder`;
    if (r.error) return r.error;
    return r.children;
  }

  function list(path: string): DirListing {
    const children = dirNode(path);
    if (typeof children === "string") return { entries: [], error: children, truncated: false };
    const entries = [...children].map(([name, node]): FileEntry => ({ name, kind: real(node).kind === "dir" ? "dir" : "file", ...(node.kind === "link" ? { link: true } : {}) })).sort(compareEntries);
    return { entries: entries.slice(0, LIST_LIMIT), error: null, truncated: entries.length > LIST_LIMIT };
  }

  function apply(op: FileOp): FileOpResult & { touched: string[] } {
    const fail = (error: string, paths: string[] = [], touched: string[] = []) => ({ ok: false, error, paths, touched });
    switch (op.kind) {
      case "create": {
        const isDir = op.path.endsWith("/");
        const path = isDir ? op.path.slice(0, -1) : op.path;
        const bad = guarded(path);
        if (bad) return fail(bad);
        if (find(path)) return fail(`${nameOf(path)} already exists`);
        const parts = path.split("/");
        let at: Map<string, Node> | string = dirNode("");
        const touched = [""];
        for (let i = 0; i < parts.length - 1; i++) {
          if (typeof at === "string") return fail(at);
          const here = parts.slice(0, i + 1).join("/");
          let next = at.get(parts[i]!);
          if (!next) {
            next = dir();
            at.set(parts[i]!, next);
          }
          touched.push(here);
          at = dirNode(here);
        }
        if (typeof at === "string") return fail(at);
        at.set(parts[parts.length - 1]!, isDir ? dir() : file());
        return { ok: true, error: null, paths: [path], touched };
      }
      case "rename": {
        const bad = guarded(op.from) ?? guarded(op.to);
        if (bad) return fail(bad);
        const node = find(op.from);
        if (!node) return fail(`${op.from} is gone`);
        if (find(op.to)) return fail(`${nameOf(op.to)} already exists`);
        const from = dirNode(parentOf(op.from));
        const to = dirNode(parentOf(op.to));
        if (typeof from === "string") return fail(from);
        if (typeof to === "string") return fail(to);
        if (op.to.startsWith(`${op.from}/`)) return fail(`${nameOf(op.from)} cannot go inside itself`);
        from.delete(nameOf(op.from));
        to.set(nameOf(op.to), node);
        return { ok: true, error: null, paths: [op.to], touched: [parentOf(op.from), parentOf(op.to)] };
      }
      case "copy":
      case "move": {
        const into = dirNode(op.into);
        if (typeof into === "string") return fail(into);
        const paths: string[] = [];
        const touched = new Set([op.into]);
        for (const from of op.from) {
          const bad = op.kind === "move" ? guarded(from) : checkPath(from);
          if (bad) return fail(bad, paths, [...touched]);
          const node = find(from);
          if (!node) return fail(`${from} is gone`, paths, [...touched]);
          if (op.into === from || op.into.startsWith(`${from}/`)) return fail(`${nameOf(from)} cannot go inside itself`, paths, [...touched]);
          if (op.kind === "move" && parentOf(from) === op.into) {
            paths.push(from);
            continue;
          }
          const name = freeName(into, nameOf(from));
          into.set(name, op.kind === "copy" ? clone(node) : node);
          if (op.kind === "move") {
            const parent = dirNode(parentOf(from));
            if (typeof parent !== "string") parent.delete(nameOf(from));
            touched.add(parentOf(from));
          }
          paths.push(join(op.into, name));
        }
        return { ok: true, error: null, paths, touched: [...touched] };
      }
      case "trash":
      case "delete": {
        const touched = new Set<string>();
        for (const path of op.paths) {
          const bad = guarded(path);
          if (bad) return fail(bad, [], [...touched]);
          const parent = dirNode(parentOf(path));
          if (typeof parent === "string" || !parent.has(nameOf(path))) return fail(`${path} is gone`, [], [...touched]);
          parent.delete(nameOf(path));
          touched.add(parentOf(path));
        }
        return { ok: true, error: null, paths: [], touched: [...touched] };
      }
    }
  }

  const source: MemorySource = {
    calls,
    latency: options.latency ?? 0,
    async list(dirs) {
      calls.push({ method: "list", dirs: [...dirs] });
      await wait(source.latency);
      return Object.fromEntries(dirs.map((d) => [d, list(d)]));
    },
    async op(op) {
      calls.push({ method: "op", op });
      await wait(source.latency);
      const failure = failures.get(op.kind);
      if (failure) {
        failures.delete(op.kind);
        return { ok: false, error: failure, paths: [] };
      }
      const { touched, ...result } = apply(op);
      // Like the server: the event follows the answer.
      if (touched.length) setTimeout(() => listeners.forEach((l) => l(touched)), 0);
      return result;
    },
    async open(path) {
      calls.push({ method: "open", path });
      await wait(source.latency);
    },
    onChanged(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    external(change, announce) {
      const { touched } = apply(change);
      for (const l of listeners) l(announce === undefined ? touched : announce);
    },
    failNext(kind, error) {
      failures.set(kind, error);
    },
    exists: (path) => find(path) !== null,
  };
  return source;
}

const wait = (ms: number) => (ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

/** The preview's workspace: a Go and Bazel monorepo. */
export function demoWorkspace(): MemoryWorkspace {
  const corpus: MemoryWorkspace = {};
  for (let i = 1; i <= 5000; i++) corpus[`doc_${String(i).padStart(5, "0")}.json`] = null;
  const goPkg = (files: string[], extra: MemoryWorkspace = {}): MemoryWorkspace => ({ "BUILD.bazel": null, ...Object.fromEntries(files.map((f) => [f, null])), ...extra });
  return {
    ".git": { HEAD: null, config: null, objects: {}, refs: { heads: { main: null } } },
    ".github": { workflows: { "ci.yml": null, "release.yml": null } },
    ".bazelrc": null,
    ".bazelversion": null,
    ".gitignore": null,
    ".editorconfig": null,
    "bazel-bin": { link: "third_party" },
    "bazel-out": { link: "../_bazel/out" },
    cmd: {
      api: goPkg(["main.go", "flags.go"]),
      worker: goPkg(["main.go"]),
      migrate: goPkg(["main.go", "main_test.go"]),
    },
    docs: { "architecture.md": null, "sessions.md": null, "runbook.md": null, adr: { "0001-bazel.md": null, "0002-grpc.md": null, "0010-sessions.md": null } },
    lib: {
      clock: goPkg(["clock.go", "clock_test.go", "fake.go"]),
      log: goPkg(["log.go", "fields.go"]),
      retry: goPkg(["retry.go", "backoff.go", "retry_test.go"]),
    },
    proto: { auth: { v1: { "auth.proto": null, "BUILD.bazel": null } }, billing: { v1: { "billing.proto": null, "BUILD.bazel": null } } },
    secrets: { error: "Permission denied" },
    services: {
      auth: goPkg(["session.go", "session_test.go", "token.go", "token_test.go", "middleware.go"], { testdata: { "expired.json": null, "valid.json": null } }),
      billing: goPkg(["invoice.go", "invoice_test.go", "stripe.go", "README.md"], { migrations: {} }),
      search: goPkg(["index.go", "query.go", "query_test.go"], { testdata: { corpus } }),
      gateway: goPkg(["router.go", "router_test.go", "cors.go"]),
    },
    third_party: { go: { "deps.bzl": null, "BUILD.bazel": null }, "README.md": null },
    tools: { lint: { "golangci.yml": null, "run.sh": null }, release: { "release.py": null, "requirements.txt": null }, empty: {} },
    web: {
      "package.json": null,
      "tsconfig.json": null,
      "vite.config.ts": null,
      src: { "main.tsx": null, "App.tsx": null, "api.ts": null, components: { "TokenBadge.tsx": null, "Button.tsx": null, "styles.css": null } },
      public: { "favicon.ico": null, "logo.svg": null },
    },
    "BUILD.bazel": null,
    "MODULE.bazel": null,
    WORKSPACE: null,
    "go.mod": null,
    "go.sum": null,
    Makefile: null,
    LICENSE: null,
    "README.md": null,
  };
}
