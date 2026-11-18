// @vitest-environment jsdom
// The rail forgets nothing when it closes: its lists come back on the row
// they were on, by what the row is, not by its place in the list.
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { railMemory, useKeyedCursor } from "../app/rail/railMemory";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Probe = { at: number; setAt(index: number): void; setRows(rows: string[]): void };
let root: Root | null = null;

/** A list on `threadId`'s remembered comment row; returns a live view of its cursor. */
function mount(threadId: string, initial: string[]): Probe {
  const probe = {} as Probe;
  function List() {
    const memory = railMemory(threadId).comments;
    const [rows, setRows] = useState(initial);
    const cursor = useKeyedCursor(rows, (row) => row, memory.row, (key) => (memory.row = key));
    Object.assign(probe, cursor, { setRows });
    return null;
  }
  root = createRoot(document.createElement("div"));
  act(() => root!.render(createElement(List)));
  return probe;
}
const unmount = () => act(() => root?.unmount());
afterEach(unmount);

describe("the rail's memory", () => {
  it("opens again on the row it was on", () => {
    const first = mount("thr_m1", ["a", "b", "c", "d"]);
    expect(first.at).toBe(0);
    act(() => first.setAt(2));
    expect(first.at).toBe(2);
    unmount();
    expect(mount("thr_m1", ["a", "b", "c", "d"]).at).toBe(2);
  });

  it("follows the row when the list changed while it was closed, or changes under it", () => {
    const first = mount("thr_m2", ["a", "b", "c", "d"]);
    act(() => first.setAt(2));
    unmount();
    const second = mount("thr_m2", ["x", "y", "a", "b", "c", "d"]);
    expect(second.at).toBe(4);
    act(() => second.setRows(["c", "a"]));
    expect(second.at).toBe(0);
  });

  it("waits for a list that is still loading, and stays in place when its row is gone", () => {
    const first = mount("thr_m3", ["a", "b", "c", "d"]);
    act(() => first.setAt(2));
    unmount();
    const second = mount("thr_m3", []);
    expect(second.at).toBe(0);
    act(() => second.setRows(["a", "b", "c", "d"]));
    expect(second.at).toBe(2);
    // The row is dropped: the cursor is on what took its place, or on the last row.
    act(() => second.setRows(["a", "b", "d"]));
    expect(second.at).toBe(2);
    act(() => second.setRows(["a"]));
    expect(second.at).toBe(0);
  });

  it("keeps each thread's place apart", () => {
    const one = mount("thr_m4", ["a", "b", "c"]);
    act(() => one.setAt(1));
    unmount();
    expect(mount("thr_m5", ["a", "b", "c"]).at).toBe(0);
    unmount();
    expect(mount("thr_m4", ["a", "b", "c"]).at).toBe(1);
  });
});
