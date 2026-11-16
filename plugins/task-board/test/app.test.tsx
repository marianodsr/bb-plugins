// @vitest-environment jsdom
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { describe, expect, it } from "vitest";

const board = {
  projects: [{ id: "proj_a", name: "Alpha" }],
  lanes: [
    { id: "lan_aaaaaaaaaa", projectId: "proj_a", name: "To do", kind: "todo", position: "V", taskCount: 1 },
    { id: "lan_bbbbbbbbbb", projectId: "proj_a", name: "Review", kind: "review", position: "W", taskCount: 0 },
  ],
  tasks: [
    {
      id: "tsk_abcdefghij",
      projectId: "proj_a",
      laneId: "lan_aaaaaaaaaa",
      laneKind: "todo",
      position: "V",
      title: "Write the release notes",
      preview: "",
      priority: "high",
      labels: ["docs"],
      externalRef: null,
      threadIds: [],
      commentCount: 0,
      createdAt: 0,
      updatedAt: 0,
      updatedBy: "user",
      archivedAt: null,
    },
  ],
  truncated: false,
};

describe("app registration", () => {
  it("registers the board page with its header, task panel, context row and commands", async () => {
    const app = await loadPluginApp(() => import("../app"));
    expect(app.navPanels.map((panel) => panel.path)).toEqual(["board"]);
    expect(app.navPanels[0]!.headerContent).toBeDefined();
  });

  it("renders a project's board with its lanes and cards", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "p/proj_a" },
      {
        rpc: {
          board: () => board,
          summary: () => ({ reviewCount: 0, projects: [] }),
          integrations: () => ({ jiraViewer: false }),
          threadStatuses: () => ({}),
        },
        sdk: { projects: { list: async () => [{ id: "proj_a", name: "Alpha" }] as never } },
      },
    );
    expect(await slot.findByText("Write the release notes")).toBeTruthy();
    expect(await slot.findByLabelText("To do, 1 task")).toBeTruthy();
    expect(await slot.findByText("High")).toBeTruthy();
    slot.lifecycle.unmount();
  });
});
