import { describe, expect, it } from "vitest";
import type { View } from "../src/schemas.js";
import { moveViewId, orderViews } from "../ui/rpc.js";

const view = (id: string, position: number): View => ({ id, name: id, jql: "x", position, builtin: false });

describe("view ordering", () => {
  it("moves one id and clamps at the ends", () => {
    expect(moveViewId(["a", "b", "c"], "c", -1)).toEqual(["a", "c", "b"]);
    expect(moveViewId(["a", "b", "c"], "a", -1)).toEqual(["a", "b", "c"]);
    expect(moveViewId(["a", "b", "c"], "a", 5)).toEqual(["b", "c", "a"]);
    expect(moveViewId(["a", "b"], "zz", 1)).toEqual(["a", "b"]);
  });

  it("predicts the server's reorder: listed ids first, the rest after, positions renumbered", () => {
    const views = [view("a", 1), view("b", 2), view("c", 3)];
    expect(orderViews(views, ["c"]).map((v) => [v.id, v.position])).toEqual([["c", 1], ["a", 2], ["b", 3]]);
    expect(orderViews(views, ["gone", "b"]).map((v) => v.id)).toEqual(["b", "a", "c"]);
  });
});
