import { describe, expect, it } from "vitest";
import type { IssueRow } from "../src/schemas.js";
import {
  DEFAULT_SOURCE,
  changedKeys,
  classifySearch,
  failureCopy,
  formatSubPath,
  groupIssues,
  moveSelection,
  parseSubPath,
  reconcileSelection,
  shortAge,
  snapshot,
  visualOrder,
} from "../ui/logic.js";

function row(key: string, statusCategory: IssueRow["statusCategory"], updated = "2026-11-10T10:00:00.000+0000"): IssueRow {
  return {
    key, id: key, summary: key, status: statusCategory, statusCategory, issueType: null, priority: null,
    assignee: null, projectKey: null, projectName: null, parentKey: null, labels: [], created: null, updated, url: "",
  };
}

describe("routes", () => {
  it("parses every route shape", () => {
    expect(parseSubPath("")).toEqual({ source: DEFAULT_SOURCE, issueKey: null });
    expect(parseSubPath("views/reported")).toEqual({ source: { kind: "view", viewId: "reported" }, issueKey: null });
    expect(parseSubPath("views/reported/ENG-412")).toEqual({ source: { kind: "view", viewId: "reported" }, issueKey: "ENG-412" });
    expect(parseSubPath("ENG-412")).toEqual({ source: null, issueKey: "ENG-412" });
    expect(parseSubPath("eng-412")).toEqual({ source: null, issueKey: "ENG-412" });
    expect(parseSubPath("search/project%20%3D%20OPS")).toEqual({ source: { kind: "search", jql: "project = OPS" }, issueKey: null });
    expect(parseSubPath("search/project%20%3D%20OPS/OPS-7")).toEqual({ source: { kind: "search", jql: "project = OPS" }, issueKey: "OPS-7" });
  });

  it("keeps a view whose id looks like a key as a view", () => {
    expect(parseSubPath("views/AB-1")).toEqual({ source: { kind: "view", viewId: "AB-1" }, issueKey: null });
  });

  it("round-trips through formatSubPath", () => {
    const cases = [
      { source: { kind: "view" as const, viewId: "my-open" }, issueKey: "ENG-1" },
      { source: { kind: "search" as const, jql: "text ~ \"a/b\"" }, issueKey: null },
    ];
    for (const route of cases) {
      const encoded = formatSubPath(route.source, route.issueKey).split("/").map(encodeURIComponent).join("/");
      expect(parseSubPath(encoded)).toEqual(route);
    }
  });
});

describe("classifySearch", () => {
  it("recognises keys, JQL and words", () => {
    expect(classifySearch("  ")).toEqual({ kind: "empty" });
    expect(classifySearch("eng-412")).toMatchObject({ kind: "key", key: "ENG-412" });
    expect(classifySearch("project = ENG")).toMatchObject({ kind: "jql", jql: "project = ENG" });
    expect(classifySearch("assignee in membersOf(dev)")).toMatchObject({ kind: "jql" });
    expect(classifySearch("labels IN (a, b)")).toMatchObject({ kind: "jql" });
    expect(classifySearch("retry and queue")).toEqual({
      kind: "text",
      text: "retry and queue",
      jql: 'text ~ "retry and queue" ORDER BY updated DESC',
    });
    expect(classifySearch('say "hi"')).toMatchObject({ kind: "text", jql: 'text ~ "say \\"hi\\"" ORDER BY updated DESC' });
  });
});

describe("grouping and selection", () => {
  const issues = [row("A-1", "todo"), row("A-2", "in_progress"), row("A-3", "done"), row("A-4", "todo")];

  it("groups in progress first and keeps Jira's order within a group", () => {
    const groups = groupIssues(issues);
    expect(groups.map((group) => group.label)).toEqual(["In progress", "To do", "Done"]);
    expect(visualOrder(groups)).toEqual(["A-2", "A-1", "A-4", "A-3"]);
    expect(groupIssues([row("A-1", "done")]).map((group) => group.category)).toEqual(["done"]);
  });

  it("moves and clamps", () => {
    const order = ["A", "B", "C"];
    expect(moveSelection(order, null, 1)).toBe("A");
    expect(moveSelection(order, null, -1)).toBe("C");
    expect(moveSelection(order, "A", -1)).toBe("A");
    expect(moveSelection(order, "B", 1)).toBe("C");
    expect(moveSelection(order, "C", 5)).toBe("C");
    expect(moveSelection([], "A", 1)).toBeNull();
    expect(moveSelection(order, "gone", 1)).toBe("A");
  });

  it("keeps the selection on a neighbour when its row disappears", () => {
    expect(reconcileSelection(["A", "B", "C"], ["A", "C"], "B")).toBe("C");
    expect(reconcileSelection(["A", "B", "C"], ["A", "B"], "C")).toBe("B");
    expect(reconcileSelection(["A", "B"], ["B", "A"], "A")).toBe("A");
    expect(reconcileSelection(["A"], [], "A")).toBeNull();
    expect(reconcileSelection([], ["X"], null)).toBeNull();
  });
});

describe("changed rows", () => {
  it("reports only rows whose updated time moved, never on first paint", () => {
    const before = [row("A-1", "todo", "t1"), row("A-2", "todo", "t1")];
    expect(changedKeys(null, before).size).toBe(0);
    const after = [row("A-1", "todo", "t2"), row("A-2", "todo", "t1"), row("A-3", "todo", "t1")];
    expect([...changedKeys(snapshot(before), after)]).toEqual(["A-1"]);
  });
});

describe("copy", () => {
  it("gives every failure a title and a direction", () => {
    const kinds = ["not_configured", "unauthorized", "forbidden", "not_found", "rate_limited", "bad_request", "timeout", "network", "server", "invalid_response"] as const;
    for (const kind of kinds) {
      const copy = failureCopy({ kind, message: "m", status: null, retryAfterMs: kind === "rate_limited" ? 4000 : null, at: 0 });
      expect(copy.title.length).toBeGreaterThan(0);
      expect(copy.title).not.toMatch(/sorry/i);
      if (copy.action !== "none") expect(copy.actionLabel).not.toBe("");
    }
    expect(failureCopy({ kind: "rate_limited", message: "", status: 429, retryAfterMs: 4000, at: 0 }).description).toContain("4 s");
  });

  it("formats short ages", () => {
    const now = Date.parse("2026-11-10T12:00:00Z");
    expect(shortAge("2026-11-10T11:59:40Z", now)).toBe("now");
    expect(shortAge("2026-11-10T11:30:00Z", now)).toBe("30m");
    expect(shortAge("2026-11-10T07:00:00Z", now)).toBe("5h");
    expect(shortAge("2026-11-07T12:00:00Z", now)).toBe("3d");
    expect(shortAge(null, now)).toBe("");
  });
});

describe("failure copy does not repeat itself", () => {
  it("drops the client's prefix under a title that says the same", () => {
    const copy = failureCopy({ kind: "bad_request", message: "Jira could not run that: Field 'x' does not exist.", status: 400, retryAfterMs: null, at: 0 });
    expect(copy.description).toBe("Field 'x' does not exist.");
  });
});
