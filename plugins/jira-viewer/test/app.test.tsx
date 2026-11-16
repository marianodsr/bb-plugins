// @vitest-environment jsdom
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { act, fireEvent } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { IssueRow, StatusResult } from "../src/schemas.js";

beforeAll(() => {
  class ResizeObserverStub {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element) {
      this.callback([{ target, contentRect: { width: 1200 } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  window.matchMedia ??= ((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
});

const status = (overrides: Partial<StatusResult> = {}): StatusResult => ({
  state: "ready", configured: true, missing: [], siteUrl: "https://acme.atlassian.net", email: "dev@example.com",
  usingOverride: false, account: { accountId: "a", displayName: "Dev User" }, error: null, checkedAt: 0,
  integrations: { taskBoard: false }, ...overrides,
});

const row = (key: string, statusCategory: IssueRow["statusCategory"]): IssueRow => ({
  key, id: key, summary: `Summary ${key}`, status: statusCategory === "in_progress" ? "In Progress" : "To Do", statusCategory,
  issueType: "Task", priority: null, assignee: null, projectKey: "A", projectName: "A", parentKey: null, labels: [],
  created: null, updated: "2026-11-10T10:00:00.000+0000", url: `https://acme.atlassian.net/browse/${key}`,
});

const list = (issues: IssueRow[]) => ({
  queryId: "q", viewId: "my-open", jql: "x", issues, hasMore: false, fetchedAt: 1, stale: false, refreshing: false, error: null,
});

const views = { views: [{ id: "my-open", name: "My open issues", jql: "x", position: 1, builtin: true }] };

// Slots share the harness runtime: unmount each so calls land on the live one.
const mounted: { lifecycle: { unmount(): void } }[] = [];
afterEach(() => {
  for (const slot of mounted.splice(0)) slot.lifecycle.unmount();
});

describe("Issues page", () => {
  it("shows the setup state when credentials are missing", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      rpc: { status: () => status({ state: "not_configured", configured: false, missing: ["email", "apiToken"] }) },
    });
    mounted.push(slot);
    await slot.findByText("Connect Jira");
    expect(slot.getByText("Open settings")).toBeTruthy();
  });

  it("groups issues and opens the one picked with J and Enter", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      rpc: {
        status: () => status(),
        "views.list": () => views,
        "issues.list": () => list([row("A-2", "todo"), row("A-1", "in_progress")]),
        "issue.get": (input: unknown) => ({ key: (input as { key: string }).key, issue: null, row: null, fetchedAt: null, stale: true, refreshing: false, error: null }),
      },
    });
    mounted.push(slot);
    await slot.findByText("Summary A-1");
    expect(slot.getByText("In progress")).toBeTruthy();
    expect(slot.getByText("To do")).toBeTruthy();
    // In progress sorts first, so J lands on A-1.
    await act(async () => {
      fireEvent.keyDown(document.body, { key: "j" });
    });
    await act(async () => {
      fireEvent.keyDown(document.body, { key: "Enter" });
    });
    const last = slot.inspection.navigateCalls.at(-1);
    expect(last).toMatchObject({ method: "toPluginPanel", path: "issues", options: { subPath: "views/my-open/A-1" } });
  });

  it("turns the search box into a JQL search on Enter", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      rpc: { status: () => status(), "views.list": () => views, "issues.list": () => list([row("A-1", "todo")]) },
    });
    mounted.push(slot);
    const input = (await slot.findByLabelText("Search issues or enter JQL")) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "project = OPS" } });
    });
    await act(async () => {
      fireEvent.submit(input.closest("form")!);
    });
    expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({ options: { subPath: "search/project = OPS" } });
  });
});
