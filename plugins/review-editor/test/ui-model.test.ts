import { describe, expect, it } from "vitest";
import { docReducer, initialDoc, reconcileDisk, type DocState } from "../app/model/doc";
import { layoutRail } from "../app/model/rail";
import { byPosition, clientCommentId, groupReview, handoffMetadata, relativeTime, sendable, step, trayLabel, walkable } from "../app/model/comments";
import { OPENER_EXTENSIONS, languageFor } from "../app/model/languages";
import { chunkKind } from "../app/editor/changes";
import { clientContract } from "../app/contract";
import { reviewMetadataSchema, rpcContract } from "../server/contract";
import type { ChangedFile, Comment } from "../server/contract";

const file = (sha256: string, content: string) => ({ sha256, content });

function comment(id: string, startLine: number, endLine = startLine, extra: Partial<Comment> = {}): Comment {
  return {
    id, environmentId: "env_1", threadId: null, path: "a.ts", startLine, endLine, snippet: "", fileSha256: "s",
    body: id, severity: "note", state: "open", sentThreadId: null, sentAt: null, resolvedAt: null, resolvedBy: null,
    acknowledgedAt: null, createdAt: 1, updatedAt: 1, replies: [], ...extra,
  };
}

describe("doc reducer and disk reconcile", () => {
  const loaded = docReducer(initialDoc, { type: "loaded", file: file("a", "one\n") });

  it("tracks dirty against the loaded content", () => {
    const edited = docReducer(loaded, { type: "edited", content: "one\ntwo\n" });
    expect(edited.dirty).toBe(true);
    expect(docReducer(edited, { type: "edited", content: "one\n" }).dirty).toBe(false);
    // Same state object when nothing changes, so React skips the render.
    expect(docReducer(loaded, { type: "edited", content: "one\n" })).toBe(loaded);
  });

  it("stays dirty when typing continued during a save", () => {
    let state = docReducer(loaded, { type: "edited", content: "one\ntwo\n" });
    state = docReducer(state, { type: "save-started" });
    state = docReducer(state, { type: "saved", sha256: "b", content: "one\ntwo\n", bufferContent: "one\ntwo\nthree\n" });
    expect(state).toMatchObject({ saving: false, dirty: true, base: { sha256: "b" } });
  });

  it("replaces a clean buffer, asks for a dirty one, and ignores its own save echo", () => {
    expect(reconcileDisk(loaded, file("a", "one\n"))).toEqual({ effect: "none" });
    expect(reconcileDisk(loaded, file("b", "x\n"))).toEqual({ effect: "replace", file: file("b", "x\n") });
    const dirty: DocState = { ...loaded, dirty: true };
    expect(reconcileDisk(dirty, file("b", "x\n"))).toEqual({ effect: "ask", file: file("b", "x\n") });
    expect(reconcileDisk({ ...dirty, external: file("b", "x\n") }, file("b", "x\n"))).toEqual({ effect: "none" });
    expect(reconcileDisk({ ...loaded, saving: true }, file("c", "y\n"))).toEqual({ effect: "none" });
    expect(reconcileDisk(initialDoc, file("a", "one\n")).effect).toBe("replace");
  });

  it("conflict, then keep mine rebases onto the disk version", () => {
    let state = docReducer(loaded, { type: "edited", content: "mine\n" });
    state = docReducer(state, { type: "save-conflict", currentSha256: "z" });
    expect(state.conflict).toEqual({ currentSha256: "z" });
    state = docReducer(state, { type: "kept-mine", file: file("z", "theirs\n"), bufferContent: "mine\n" });
    expect(state).toMatchObject({ conflict: null, base: { sha256: "z" }, dirty: true });
    expect(docReducer(state, { type: "took-disk", file: file("z", "theirs\n") })).toEqual({ ...initialDoc, base: file("z", "theirs\n") });
  });
});

describe("rail layout", () => {
  it("places notes at their anchors when they fit", () => {
    const tops = layoutRail([{ id: "a", anchor: 0, height: 50 }, { id: "b", anchor: 200, height: 50 }], null);
    expect([...tops]).toEqual([["a", 0], ["b", 200]]);
  });

  it("never overlaps: later notes are pushed down by the gap", () => {
    const tops = layoutRail([{ id: "a", anchor: 0, height: 100 }, { id: "b", anchor: 20, height: 50 }, { id: "c", anchor: 30, height: 10 }], null);
    expect(tops.get("b")).toBe(108);
    expect(tops.get("c")).toBe(166);
  });

  it("keeps the active note on its anchor and moves earlier notes up", () => {
    const tops = layoutRail([{ id: "a", anchor: 100, height: 80 }, { id: "b", anchor: 120, height: 40 }], "b");
    expect(tops.get("b")).toBe(120);
    expect(tops.get("a")).toBe(120 - 8 - 80);
  });

  it("falls back to packing downward when there is no room above", () => {
    const tops = layoutRail([{ id: "a", anchor: 0, height: 80 }, { id: "b", anchor: 10, height: 40 }], "b");
    expect(tops.get("a")).toBe(0);
    expect(tops.get("b")).toBe(88);
  });
});

describe("comment walk", () => {
  const list = [comment("c", 30), comment("a", 5), comment("r", 10, 10, { state: "resolved" }), comment("b", 12, 14)];

  it("keeps agent resolutions in the walk until the reviewer acknowledges them", () => {
    const agent = comment("g", 20, 20, { state: "resolved", resolvedBy: "agent" });
    expect(walkable([...list, agent]).map((c) => c.id)).toEqual(["a", "b", "g", "c"]);
    expect(walkable([...list, { ...agent, acknowledgedAt: 5 }]).map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(groupReview([], [agent], "open")[0]?.comments.map((c) => c.id)).toEqual(["g"]);
  });

  it("orders by position and skips resolved comments", () => {
    expect(walkable(list).map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect([...list].sort(byPosition).map((c) => c.id)).toEqual(["a", "r", "b", "c"]);
  });

  it("steps from the active comment and wraps", () => {
    expect(step(list, { activeId: "a", line: 1 }, 1)?.id).toBe("b");
    expect(step(list, { activeId: "c", line: 1 }, 1)?.id).toBe("a");
    expect(step(list, { activeId: "a", line: 1 }, -1)?.id).toBe("c");
  });

  it("without an active comment, steps from the cursor line", () => {
    expect(step(list, { activeId: null, line: 6 }, 1)?.id).toBe("b");
    expect(step(list, { activeId: null, line: 6 }, -1)?.id).toBe("a");
    expect(step(list, { activeId: null, line: 40 }, 1)?.id).toBe("a");
    expect(step([], { activeId: null, line: 1 }, 1)).toBeNull();
  });

  it("hands off only comments not yet sent and not resolved", () => {
    const mixed = [comment("open", 1), comment("sent", 2, 2, { state: "sent", sentThreadId: "t" }), comment("outdated", 3, 3, { state: "outdated" }), comment("done", 4, 4, { state: "resolved" })];
    expect(sendable(mixed).map((c) => c.id)).toEqual(["open", "outdated"]);
  });

  it("makes ids the server accepts", () => {
    for (let i = 0; i < 50; i += 1) expect(clientCommentId()).toMatch(/^rc_[a-z0-9]{10}$/u);
  });

  it("says when", () => {
    expect(relativeTime(0, 10_000)).toBe("just now");
    expect(relativeTime(0, 5 * 60_000)).toBe("5 min ago");
    expect(relativeTime(0, 3 * 3_600_000)).toBe("3 h ago");
  });
});

describe("tray copy", () => {
  it("never double counts sent comments", () => {
    expect(trayLabel(0, 0)).toBe("No open comments");
    expect(trayLabel(1, 1)).toBe("1 open comment");
    expect(trayLabel(3, 3)).toBe("3 open comments");
    expect(trayLabel(3, 0)).toBe("3 open, all sent");
    expect(trayLabel(3, 1)).toBe("3 open, 1 not sent");
    expect(trayLabel(1, 0, 2)).toBe("1 open, all sent, 2 resolved by agent");
    expect(trayLabel(0, 0, 2)).toBe("2 resolved by agent");
    expect(trayLabel(4, 3, 1, true)).toBe("4 open, 1 by agent");
    expect(trayLabel(0, 0, 1, true)).toBe("1 resolved by agent");
  });
});

describe("languages and opener extensions", () => {
  it("maps files to syntaxes", () => {
    expect(languageFor("src/app.tsx")).toBe("tsx");
    expect(languageFor("Dockerfile")).toBe("dockerfile");
    expect(languageFor("deploy/Dockerfile.prod")).toBe("dockerfile");
    expect(languageFor(".env.local")).toBe("properties");
    expect(languageFor("README")).toBe("text");
    expect(languageFor("a/b.unknownext")).toBe("text");
  });

  it("claims code and text extensions, but leaves images and tables to bb", () => {
    for (const extension of ["ts", "tsx", "py", "md", "json", "yaml", "txt", "go", "rs"]) expect(OPENER_EXTENSIONS).toContain(extension);
    for (const extension of ["svg", "csv", "png"]) expect(OPENER_EXTENSIONS).not.toContain(extension);
    for (const extension of OPENER_EXTENSIONS) expect(extension).toMatch(/^[a-z0-9]+$/u);
  });
});

describe("change bars", () => {
  it("classifies chunks", () => {
    expect(chunkKind({ fromA: 5, toA: 5, fromB: 5, toB: 12 })).toBe("added");
    expect(chunkKind({ fromA: 5, toA: 12, fromB: 5, toB: 5 })).toBe("removed");
    expect(chunkKind({ fromA: 5, toA: 12, fromB: 5, toB: 9 })).toBe("modified");
  });
});

describe("Review tab grouping", () => {
  const changed: ChangedFile[] = [
    { path: "b.ts", previousPath: null, changeKind: "modified", additions: 1, deletions: 0, binary: false, origin: "tracked", revision: "r", comments: { open: 0, sent: 0, resolved: 0, outdated: 0 } },
  ];
  const comments = [comment("x", 3, 3, { path: "b.ts" }), comment("y", 1, 1, { path: "a.ts" }), comment("z", 9, 9, { path: "a.ts", state: "resolved" })];

  it("lists changed files first, then commented files, comments in file order", () => {
    expect(groupReview(changed, comments, "open").map((g) => [g.path, g.comments.map((c) => c.id)])).toEqual([["b.ts", ["x"]], ["a.ts", ["y"]]]);
    expect(groupReview(changed, comments, "all").find((g) => g.path === "a.ts")?.comments.map((c) => c.id)).toEqual(["y", "z"]);
  });
});

describe("client contract", () => {
  it("has every server method and the same read tags, without bundling zod", () => {
    expect(Object.keys(clientContract).sort()).toEqual(Object.keys(rpcContract).sort());
    const input = { environmentId: "env_1", path: "a.ts", sentThreadId: "thr_1", id: "rc_0123456789" };
    for (const method of Object.keys(rpcContract) as (keyof typeof rpcContract)[]) {
      const server = (rpcContract[method] as { tags?: (i: unknown, o: unknown) => readonly string[] }).tags;
      const client = (clientContract[method] as { tags?: (i: unknown, o: unknown) => readonly string[] }).tags;
      expect(client?.(input, null), method).toEqual(server?.(input, null));
    }
  });
});

describe("handoff metadata", () => {
  it("is what the server's schema accepts", () => {
    const metadata = handoffMetadata([{ id: "rc_0123456789" }, { id: "rc_abcdefghij" }], "env_xy74y9yxm4", 1_700_000_000_000);
    expect(reviewMetadataSchema.parse(metadata.review)).toEqual({
      version: 1,
      environmentId: "env_xy74y9yxm4",
      commentIds: ["rc_0123456789", "rc_abcdefghij"],
      sentAt: 1_700_000_000_000,
    });
    const many = Array.from({ length: 250 }, (_, i) => ({ id: `rc_${String(i).padStart(10, "0")}` }));
    expect(reviewMetadataSchema.safeParse(handoffMetadata(many, "env_1", 1).review).success).toBe(true);
  });
});
