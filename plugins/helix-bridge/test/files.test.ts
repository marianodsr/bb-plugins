// The file tree's host half (host/files.ts) and the server's change signal
// (server/files.ts), against temporary folders only.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { z } from "zod";
import type { DirListing, FileOp, FileOpResult } from "../app/files/types";
import { LIST_LIMIT, applyOp, listDirs } from "../host/files";
import { Files, type FilesDeps } from "../server/files";
import type { dirListingSchema, fileOpResultSchema, fileOpSchema } from "../shared/host-contract";

let root: string;
let outside: string;
let trash: string;

const fresh = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));
const file = (path: string, body = "") => {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), body);
};
const dir = (path: string) => mkdirSync(join(root, path), { recursive: true });
const names = (listing: DirListing | undefined) => listing?.entries.map((e) => e.name);
const op = (o: FileOp) => applyOp(root, o, { trashDir: trash });
const has = (path: string) => existsSync(join(root, path));

beforeEach(() => {
  root = fresh("hxf-root-");
  outside = fresh("hxf-out-");
  trash = fresh("hxf-trash-");
  writeFileSync(join(outside, "secret.txt"), "keep");
});

afterEach(() => {
  for (const d of [root, outside, trash]) rmSync(d, { recursive: true, force: true });
});

describe("the contract", () => {
  it("the RPC schemas carry exactly the shapes of app/files/types.ts", () => {
    expectTypeOf<z.infer<typeof dirListingSchema>>().toEqualTypeOf<DirListing>();
    expectTypeOf<z.infer<typeof fileOpSchema>>().toEqualTypeOf<FileOp>();
    expectTypeOf<z.infer<typeof fileOpResultSchema>>().toEqualTypeOf<FileOpResult>();
  });
});

describe("list", () => {
  it("puts folders first, then files, each in natural order with case ignored, dot files included", async () => {
    for (const d of ["b", "A", "a10", "a2", ".hidden"]) dir(d);
    for (const f of ["z.go", "B.txt", "file10", "file2", "a.go", ".env", "File3"]) file(f);
    const { "": listing } = await listDirs(root, [""]);
    expect(listing?.error).toBeNull();
    expect(listing?.truncated).toBe(false);
    expect(names(listing)).toEqual([".hidden", "A", "a2", "a10", "b", ".env", "a.go", "B.txt", "file2", "File3", "file10", "z.go"]);
    expect(listing?.entries.slice(0, 5).every((e) => e.kind === "dir" && !e.link)).toBe(true);
    expect(listing?.entries.slice(5).every((e) => e.kind === "file" && !e.link)).toBe(true);
  });

  it("follows links for their kind: to a file, to a folder, broken, and out of the workspace (which it may read)", async () => {
    file("real.go");
    dir("pkg");
    symlinkSync("real.go", join(root, "to-file"));
    symlinkSync("pkg", join(root, "to-dir"));
    symlinkSync("nowhere", join(root, "broken"));
    symlinkSync(outside, join(root, "bazel-out"));
    const result = await listDirs(root, ["", "bazel-out"]);
    const byName = Object.fromEntries(result[""]!.entries.map((e) => [e.name, e]));
    expect(byName["to-file"]).toEqual({ name: "to-file", kind: "file", link: true });
    expect(byName["to-dir"]).toEqual({ name: "to-dir", kind: "dir", link: true });
    expect(byName.broken).toEqual({ name: "broken", kind: "file", link: true });
    expect(byName["bazel-out"]).toEqual({ name: "bazel-out", kind: "dir", link: true });
    expect(names(result[""])).toEqual(["bazel-out", "pkg", "to-dir", "broken", "real.go", "to-file"]);
    expect(names(result["bazel-out"])).toEqual(["secret.txt"]);
  });

  it("returns at most 5 000 entries of a folder and says it is truncated", async () => {
    dir("big");
    dir("exact");
    for (let i = 0; i < LIST_LIMIT + 1; i += 1) writeFileSync(join(root, "big", `f${i}`), "");
    for (let i = 0; i < LIST_LIMIT; i += 1) writeFileSync(join(root, "exact", `f${i}`), "");
    const result = await listDirs(root, ["big", "exact"]);
    expect(result.big?.entries).toHaveLength(LIST_LIMIT);
    expect(result.big?.truncated).toBe(true);
    expect(result.exact?.entries).toHaveLength(LIST_LIMIT);
    expect(result.exact?.truncated).toBe(false);
  });

  it("reads many folders in one call, each a key of the answer, and says in words what it could not read", async () => {
    dir("a/b");
    file("a/b/c.go");
    file("plain.txt");
    const result = await listDirs(root, ["a", "a/b", "gone", "plain.txt", "../etc", "/etc", "a//b", "a/./b", "a/b"]);
    expect(Object.keys(result).sort()).toEqual(["../etc", "/etc", "a", "a/./b", "a//b", "a/b", "gone", "plain.txt"]);
    expect(names(result.a)).toEqual(["b"]);
    expect(names(result["a/b"])).toEqual(["c.go"]);
    expect(result.gone).toEqual({ entries: [], error: "This folder is not there any more", truncated: false });
    expect(result["plain.txt"]?.error).toBe("This is not a folder");
    for (const bad of ["../etc", "/etc", "a//b", "a/./b"]) expect(result[bad]?.error).toMatch(/cannot have|Not a path in the workspace/u);
    const missing = await listDirs(join(root, "no-such-workspace"), [""]);
    expect(missing[""]?.error).toBe("The workspace is not there");
  });

  it("refuses a workspace that is not an absolute path", async () => {
    await expect(listDirs("relative/root", [""])).rejects.toThrow(/absolute/u);
  });
});

describe("create", () => {
  it("makes a file, a folder (a name ending in /), and the folders on the way", async () => {
    expect(await op({ kind: "create", path: "main.go" })).toEqual({ ok: true, error: null, paths: ["main.go"], touched: [""] });
    expect(lstatSync(join(root, "main.go")).isFile()).toBe(true);
    expect(await op({ kind: "create", path: "pkg/" })).toEqual({ ok: true, error: null, paths: ["pkg"], touched: [""] });
    expect(lstatSync(join(root, "pkg")).isDirectory()).toBe(true);
    const nested = await op({ kind: "create", path: "pkg/a/b/c.go" });
    expect(nested).toMatchObject({ ok: true, paths: ["pkg/a/b/c.go"] });
    expect(nested.touched.sort()).toEqual(["pkg", "pkg/a", "pkg/a/b"]);
    expect(lstatSync(join(root, "pkg/a/b/c.go")).isFile()).toBe(true);
    expect((await op({ kind: "create", path: "x/y/" })).paths).toEqual(["x/y"]);
    expect(lstatSync(join(root, "x/y")).isDirectory()).toBe(true);
  });

  it("never replaces: a taken name fails and the file keeps its content", async () => {
    file("main.go", "package main");
    dir("pkg");
    expect(await op({ kind: "create", path: "main.go" })).toMatchObject({ ok: false, error: "main.go is taken", paths: [] });
    expect(await op({ kind: "create", path: "pkg/" })).toMatchObject({ ok: false, error: "pkg is taken" });
    expect(await op({ kind: "create", path: "main.go/" })).toMatchObject({ ok: false, error: "main.go is taken" });
    expect(readFileSync(join(root, "main.go"), "utf8")).toBe("package main");
  });

  it("says so when a folder on the way is a file", async () => {
    file("main.go");
    expect(await op({ kind: "create", path: "main.go/x/y.go" })).toMatchObject({ ok: false, error: "main.go is not a folder" });
  });
});

describe("rename", () => {
  it("renames an entry, or moves it to a full new path", async () => {
    file("a.go", "a");
    dir("pkg");
    expect(await op({ kind: "rename", from: "a.go", to: "b.go" })).toEqual({ ok: true, error: null, paths: ["b.go"], touched: [""] });
    expect(readFileSync(join(root, "b.go"), "utf8")).toBe("a");
    const moved = await op({ kind: "rename", from: "b.go", to: "pkg/c.go" });
    expect(moved).toMatchObject({ ok: true, paths: ["pkg/c.go"] });
    expect(moved.touched.sort()).toEqual(["", "pkg"]);
    expect(has("b.go")).toBe(false);
  });

  it("never replaces, needs the folder it goes to, and cannot put a folder into itself", async () => {
    file("a.go", "a");
    file("b.go", "b");
    dir("pkg/inner");
    expect(await op({ kind: "rename", from: "a.go", to: "b.go" })).toMatchObject({ ok: false, error: "b.go is taken" });
    expect(readFileSync(join(root, "b.go"), "utf8")).toBe("b");
    expect(await op({ kind: "rename", from: "a.go", to: "nope/a.go" })).toMatchObject({ ok: false, error: "nope is not there" });
    expect(await op({ kind: "rename", from: "pkg", to: "pkg/inner/pkg" })).toMatchObject({ ok: false, error: "pkg cannot go into itself" });
    expect(await op({ kind: "rename", from: "missing.go", to: "m.go" })).toMatchObject({ ok: false, error: "missing.go is not there" });
  });

  it("changes only the case of a name on a disk that ignores case", async () => {
    file("readme.md", "x");
    const caseless = existsSync(join(root, "README.md"));
    const result = await op({ kind: "rename", from: "readme.md", to: "README.md" });
    expect(result.ok).toBe(true);
    expect(readdirSync(root)).toEqual(["README.md"]);
    if (!caseless) expect(has("readme.md")).toBe(false);
  });
});

describe("copy", () => {
  it("copies files and whole folders, taking name_1.ext, name_2.ext when the name is taken", async () => {
    file("src/main.go", "m");
    file("src/lib/util.go", "u");
    file("src/.env", "e");
    dir("dst");
    file("dst/main.go", "old");
    const first = await op({ kind: "copy", from: ["src/main.go", "src/lib", "src/.env"], into: "dst" });
    expect(first).toEqual({ ok: true, error: null, paths: ["dst/main_1.go", "dst/lib", "dst/.env"], touched: ["dst"] });
    expect(readFileSync(join(root, "dst/main.go"), "utf8")).toBe("old");
    expect(readFileSync(join(root, "dst/main_1.go"), "utf8")).toBe("m");
    expect(readFileSync(join(root, "dst/lib/util.go"), "utf8")).toBe("u");
    const second = await op({ kind: "copy", from: ["src/main.go", "src/lib", "src/.env"], into: "dst" });
    expect(second.paths).toEqual(["dst/main_2.go", "dst/lib_1", "dst/.env_1"]);
    // Into the folder it is in: a copy beside it.
    expect((await op({ kind: "copy", from: ["src/main.go"], into: "src" })).paths).toEqual(["src/main_1.go"]);
    expect((await op({ kind: "copy", from: ["src/main.go"], into: "" })).paths).toEqual(["main.go"]);
  });

  it("copies a link as a link, never what it points to", async () => {
    file("real.go", "r");
    dir("dst");
    symlinkSync("real.go", join(root, "to-file"));
    symlinkSync(outside, join(root, "out"));
    expect((await op({ kind: "copy", from: ["to-file", "out"], into: "dst" })).paths).toEqual(["dst/to-file", "dst/out"]);
    expect(lstatSync(join(root, "dst/to-file")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(root, "dst/to-file"))).toBe("real.go");
    expect(lstatSync(join(root, "dst/out")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(root, "dst/out"))).toBe(outside);
  });

  it("refuses to copy a folder into itself", async () => {
    dir("pkg/inner");
    expect(await op({ kind: "copy", from: ["pkg"], into: "pkg/inner" })).toMatchObject({ ok: false, error: "pkg cannot go into itself", paths: [] });
    expect(await op({ kind: "copy", from: ["pkg"], into: "pkg" })).toMatchObject({ ok: false, error: "pkg cannot go into itself" });
    expect(readdirSync(join(root, "pkg"))).toEqual(["inner"]);
  });
});

describe("move", () => {
  it("moves entries into a folder with the same rule for taken names", async () => {
    file("a.go", "new");
    file("dst/a.go", "old");
    dir("pkg/x");
    const result = await op({ kind: "move", from: ["a.go", "pkg"], into: "dst" });
    expect(result).toMatchObject({ ok: true, paths: ["dst/a_1.go", "dst/pkg"] });
    expect(result.touched.sort()).toEqual(["", "dst"]);
    expect(readFileSync(join(root, "dst/a.go"), "utf8")).toBe("old");
    expect(readFileSync(join(root, "dst/a_1.go"), "utf8")).toBe("new");
    expect(has("dst/pkg/x")).toBe(true);
    expect(has("a.go") || has("pkg")).toBe(false);
  });

  it("leaves an entry already in that folder where it is, and refuses a folder into itself", async () => {
    file("pkg/a.go");
    dir("pkg/inner");
    expect(await op({ kind: "move", from: ["pkg/a.go"], into: "pkg" })).toEqual({ ok: true, error: null, paths: ["pkg/a.go"], touched: [] });
    expect(readdirSync(join(root, "pkg")).sort()).toEqual(["a.go", "inner"]);
    expect(await op({ kind: "move", from: ["pkg"], into: "pkg/inner" })).toMatchObject({ ok: false, error: "pkg cannot go into itself" });
  });

  it("stops at the first failure; the ones before it were done", async () => {
    file("a.go");
    file("c.go");
    dir("dst");
    expect(await op({ kind: "move", from: ["a.go", "b.go", "c.go"], into: "dst" })).toEqual({ ok: false, error: "b.go is not there", paths: ["dst/a.go"], touched: ["", "dst"] });
    expect(has("c.go")).toBe(true);
  });
});

describe("trash and delete", () => {
  it("moves into the trash under a free name (macOS)", async () => {
    file("a.go", "1");
    expect(await applyOp(root, { kind: "trash", paths: ["a.go"] }, { trashDir: trash, platform: "darwin" })).toEqual({ ok: true, error: null, paths: [], touched: [""] });
    file("a.go", "2");
    dir("pkg/x");
    expect((await applyOp(root, { kind: "trash", paths: ["a.go", "pkg"] }, { trashDir: trash, platform: "darwin" })).ok).toBe(true);
    expect(readdirSync(trash).sort()).toEqual(["a.go", "a_1.go", "pkg"]);
    expect(readFileSync(join(trash, "a_1.go"), "utf8")).toBe("2");
    expect(readdirSync(root)).toEqual([]);
  });

  it("says D deletes for good where there is no trash", async () => {
    file("a.go");
    const linux = await applyOp(root, { kind: "trash", paths: ["a.go"] }, { platform: "linux", findExecutable: () => null });
    expect(linux).toMatchObject({ ok: false, error: expect.stringMatching(/D deletes for good/u) });
    const noTrashFolder = await applyOp(root, { kind: "trash", paths: ["a.go"] }, { platform: "darwin", trashDir: join(trash, "none") });
    expect(noTrashFolder.error).toMatch(/D deletes for good/u);
    expect(has("a.go")).toBe(true);
  });

  it("deletes exactly the paths given, folders whole, a link and not what it points to", async () => {
    file("a.go");
    file("pkg/x/y.go");
    file("keep.go");
    symlinkSync(outside, join(root, "out"));
    expect(await op({ kind: "delete", paths: ["a.go", "pkg", "out"] })).toEqual({ ok: true, error: null, paths: [], touched: [""] });
    expect(readdirSync(root)).toEqual(["keep.go"]);
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("keep");
  });

  it("checks every path before it changes any", async () => {
    file("a.go");
    expect(await op({ kind: "delete", paths: ["a.go", "missing.go"] })).toMatchObject({ ok: false, error: "missing.go is not there" });
    expect(has("a.go")).toBe(true);
  });
});

describe("safety", () => {
  beforeEach(() => {
    file("a.go");
    dir("pkg");
    file(".git/config", "[core]");
    dir("sub/.git");
    symlinkSync(outside, join(root, "out"));
    symlinkSync(join(outside, "secret.txt"), join(root, "secret-link"));
  });

  const refusals: [string, FileOp, RegExp][] = [
    ["an absolute path", { kind: "create", path: "/tmp/x.go" }, /Not a path in the workspace/u],
    ["an absolute source", { kind: "delete", paths: ["/etc/hosts"] }, /Not a path in the workspace/u],
    ["..", { kind: "create", path: "../x.go" }, /cannot have a "\.\." part/u],
    [".. in the middle", { kind: "rename", from: "a.go", to: "pkg/../../a.go" }, /cannot have a "\.\." part/u],
    [".. into", { kind: "copy", from: ["a.go"], into: ".." }, /cannot have a "\.\." part/u],
    ["an empty part", { kind: "trash", paths: ["pkg//a.go"] }, /empty part/u],
    ["NUL", { kind: "create", path: "a\0.go" }, /NUL/u],
    ["create through a link that leaves", { kind: "create", path: "out/x.go" }, /out leads out of the workspace/u],
    ["create deep through a link that leaves", { kind: "create", path: "out/new/x.go" }, /leads out of the workspace/u],
    ["rename into a link that leaves", { kind: "rename", from: "a.go", to: "out/a.go" }, /out leads out of the workspace/u],
    ["rename from a link that leaves", { kind: "rename", from: "out/secret.txt", to: "s.txt" }, /out leads out of the workspace/u],
    ["copy into a link that leaves", { kind: "copy", from: ["a.go"], into: "out" }, /out leads out of the workspace/u],
    ["copy from a link that leaves", { kind: "copy", from: ["out/secret.txt"], into: "pkg" }, /out leads out of the workspace/u],
    ["move from a link that leaves", { kind: "move", from: ["out/secret.txt"], into: "pkg" }, /out leads out of the workspace/u],
    ["trash under a link that leaves", { kind: "trash", paths: ["out/secret.txt"] }, /out leads out of the workspace/u],
    ["delete under a link that leaves", { kind: "delete", paths: ["out/secret.txt"] }, /out leads out of the workspace/u],
    ["rename the workspace", { kind: "rename", from: "", to: "x" }, /workspace itself/u],
    ["move the workspace", { kind: "move", from: [""], into: "pkg" }, /workspace itself/u],
    ["trash the workspace", { kind: "trash", paths: [""] }, /workspace itself/u],
    ["delete the workspace", { kind: "delete", paths: [""] }, /workspace itself/u],
    ["rename .git", { kind: "rename", from: ".git", to: "git" }, /\.git is not changed/u],
    ["move .git", { kind: "move", from: [".git"], into: "pkg" }, /\.git is not changed/u],
    ["trash .git", { kind: "trash", paths: [".git"] }, /\.git is not changed/u],
    ["delete .git", { kind: "delete", paths: [".git"] }, /\.git is not changed/u],
    ["delete under .git", { kind: "delete", paths: [".git/config"] }, /\.git is not changed/u],
    ["delete .GIT", { kind: "delete", paths: [".GIT"] }, /\.git is not changed/u],
    ["delete a submodule's .git", { kind: "delete", paths: ["sub/.git"] }, /\.git is not changed/u],
    ["rename into .git", { kind: "rename", from: "a.go", to: ".git/a.go" }, /\.git is not changed/u],
    ["create in .git", { kind: "create", path: ".git/hooks/pre-commit" }, /\.git is not changed/u],
    ["copy into .git", { kind: "copy", from: ["a.go"], into: ".git" }, /\.git is not changed/u],
  ];

  it.each(refusals)("refuses %s and changes nothing", async (_label, refused, why) => {
    const before = { root: readdirSync(root).sort(), outside: readdirSync(outside).sort(), git: readdirSync(join(root, ".git")) };
    const result = await op(refused);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(why);
    expect(result.paths).toEqual([]);
    expect({ root: readdirSync(root).sort(), outside: readdirSync(outside).sort(), git: readdirSync(join(root, ".git")) }).toEqual(before);
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("keep");
  });

  it("acts on a link itself, which is in the workspace, never on what it points to", async () => {
    expect((await op({ kind: "rename", from: "secret-link", to: "renamed-link" })).ok).toBe(true);
    expect(lstatSync(join(root, "renamed-link")).isSymbolicLink()).toBe(true);
    expect((await op({ kind: "move", from: ["renamed-link"], into: "pkg" })).paths).toEqual(["pkg/renamed-link"]);
    expect((await op({ kind: "delete", paths: ["pkg/renamed-link", "out"] })).ok).toBe(true);
    expect(readdirSync(outside)).toEqual(["secret.txt"]);
  });

  it("refuses a workspace whose path is not absolute", async () => {
    expect(await applyOp("rel", { kind: "create", path: "a.go" })).toMatchObject({ ok: false, error: expect.stringMatching(/absolute/u) });
  });
});

describe("the server's change signal", () => {
  function files(info: { environmentId: string | null; hostId: string | null; path: string | null }) {
    const published: { threadId: string; dirs: string[] | null }[] = [];
    const deps: FilesDeps = {
      service: { threadInfo: async () => ({ ...info, title: null }) } as never,
      hostCall: async (method, input) => (method === "filesList" ? listDirs(String(input.root), input.dirs as string[]) : applyOp(String(input.root), input.op as FileOp, { trashDir: trash })),
      publish: (payload) => published.push(payload),
      log: () => {},
    };
    return { files: new Files(deps), published };
  }

  afterEach(() => vi.useRealTimers());

  it("lists against the thread's workspace and publishes the folders an operation touched", async () => {
    const { files: f, published } = files({ environmentId: "env_1", hostId: "host_1", path: root });
    dir("pkg");
    expect(await f.list("thr_1", ["", "pkg"])).toEqual({ root, dirs: { "": { entries: [{ name: "pkg", kind: "dir" }], error: null, truncated: false }, pkg: { entries: [], error: null, truncated: false } } });
    expect(await f.op("thr_1", { kind: "create", path: "pkg/a.go" })).toEqual({ ok: true, error: null, paths: ["pkg/a.go"] });
    expect(published).toEqual([{ threadId: "thr_1", dirs: ["pkg"] }]);
    // A refusal touches nothing and publishes nothing.
    expect(await f.op("thr_1", { kind: "delete", paths: [".git"] })).toMatchObject({ ok: false });
    expect(published).toHaveLength(1);
  });

  it("says so in every folder when the thread has no workspace", async () => {
    const { files: f } = files({ environmentId: null, hostId: null, path: null });
    expect(await f.list("thr_1", ["", "a"])).toEqual({ root: "", dirs: { "": { entries: [], error: "This thread has no workspace", truncated: false }, a: { entries: [], error: "This thread has no workspace", truncated: false } } });
    expect(await f.op("thr_1", { kind: "create", path: "a" })).toEqual({ ok: false, error: "This thread has no workspace", paths: [] });
  });

  it("tells the trees reading an environment that it changed, at most once a second per thread", async () => {
    vi.useFakeTimers({ now: 10_000 });
    const { files: f, published } = files({ environmentId: "env_1", hostId: "host_1", path: root });
    f.environmentChanged("env_1");
    expect(published).toEqual([]);
    await f.list("thr_1", [""]);
    f.environmentChanged("env_1");
    f.environmentChanged("env_1");
    f.anything("thr_1");
    f.environmentChanged("env_other");
    expect(published).toEqual([{ threadId: "thr_1", dirs: null }]);
    vi.advanceTimersByTime(999);
    expect(published).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(published).toEqual([{ threadId: "thr_1", dirs: null }, { threadId: "thr_1", dirs: null }]);
    vi.advanceTimersByTime(5000);
    expect(published).toHaveLength(2);
    f.anything("thr_2");
    expect(published.at(-1)).toEqual({ threadId: "thr_2", dirs: null });
    f.dispose();
  });
});
