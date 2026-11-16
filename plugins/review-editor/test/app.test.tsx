// @vitest-environment jsdom
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { describe, expect, it } from "vitest";

// jsdom lacks ResizeObserver; the kit's width hook needs one.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const comments = [
  {
    id: "rc_0123456789", environmentId: "env_1", threadId: null, path: "src/a.ts", startLine: 3, endLine: 4, snippet: "x",
    fileSha256: "s", body: "Name the unit", severity: "issue", state: "open", sentThreadId: null, sentAt: null,
    resolvedAt: null, resolvedBy: null, acknowledgedAt: null, createdAt: 1, updatedAt: 1, replies: [],
  },
];

describe("app registrations", () => {
  it("registers the editor opener for code and text files", async () => {
    const app = await loadPluginApp(() => import("../app"));
    expect(app.fileOpeners).toHaveLength(1);
    expect(app.fileOpeners[0]).toMatchObject({ id: "editor", title: "Review Editor" });
    expect(app.fileOpeners[0]!.extensions).toEqual(expect.arrayContaining(["ts", "md", "py"]));
  });

  it("renders the Review tab: changed files, then commented files, with their comments", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const tab = app.tabs.find((candidate) => candidate.id === "review");
    expect(tab).toMatchObject({ availability: "fixed", context: { kind: "thread" } });
    const slot = renderSlot(tab as never, { threadId: "thr_1", environment: { id: "env_1" } } as never, {
      rpc: {
        changedFiles: () => ({
          outcome: "available", truncated: false, shortstat: "1 file changed", mergeBaseRef: null, commentedFiles: [],
          files: [{ path: "src/b.ts", previousPath: null, changeKind: "modified", additions: 2, deletions: 1, binary: false, origin: "tracked", revision: "r", comments: { open: 0, sent: 0, resolved: 0, outdated: 0 } }],
        }),
        listComments: () => ({ comments }),
      },
    } as never);
    await slot.findByText("Name the unit", undefined, { timeout: 5_000 });
    expect(slot.container.textContent).toContain("1 file changed");
    expect(slot.container.textContent).toContain("b.ts");
    expect(slot.container.textContent).toContain("1 to send");
    slot.lifecycle.unmount();
  });
});
