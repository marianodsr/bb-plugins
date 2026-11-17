// @vitest-environment jsdom
// The composer's position chip must never touch the draft while the user
// types: the pill is added only at the moment of submit.
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { describe, expect, it } from "vitest";
import { isSubmitKey } from "../app/composer/ComposerParts";

const instance = {
  key: "host_t:42",
  hostId: "host_t",
  pid: 42,
  status: "connected",
  error: null,
  helixVersion: "mock",
  workspaceRoot: "/w",
  threadId: "thr_a",
  threadTitle: "A",
  bindingSource: "explicit",
  terminalId: null,
  focus: { path: "main.go", absolutePath: "/w/main.go", line: 12, col: 3, endLine: null, modified: false },
  mode: "normal",
  diagnostics: { errors: 0, warnings: 0 },
  capabilities: ["editor"],
  commandPolicy: "safe",
  pendingSends: 0,
  skippedModified: [],
};

async function positionChip() {
  const app = await loadPluginApp(() => import("../app"));
  const customization = app.composerCustomizations.find((c) => c.id === "helix")!;
  const banner = customization.banners!.find((b) => b.id === "position")!;
  return renderSlot(banner as never, {} as never, {
    rpc: { threadStatus: () => ({ instance, candidates: 1 }) },
    settings: { positionInMessages: true },
    composer: { scope: { kind: "thread", threadId: "thr_a" }, text: "" },
  });
}

describe("editor position in the composer", () => {
  it("leaves the draft exactly as typed, key by key", async () => {
    const slot = await positionChip();
    await slot.findByText("Sending position");
    expect(slot.getByText("main.go:12")).toBeTruthy();
    let typed = "";
    for (const key of "how is it going") {
      typed += key;
      await slot.behavior.setComposerText(typed);
      expect(slot.inspection.composer.text).toBe(typed);
      expect(slot.inspection.composer.draft.mentions).toEqual([]);
    }
    expect(slot.inspection.composer.mentions).toEqual([]);
    slot.lifecycle.unmount();
  });

  it("treats only a plain Enter with no menu open as submit", () => {
    const enter = { key: "Enter", shiftKey: false, altKey: false, isComposing: false };
    expect(isSubmitKey(enter, false)).toBe(true);
    expect(isSubmitKey({ ...enter, shiftKey: true }, false)).toBe(false);
    expect(isSubmitKey({ ...enter, isComposing: true }, false)).toBe(false);
    expect(isSubmitKey(enter, true)).toBe(false);
    expect(isSubmitKey({ ...enter, key: "a" }, false)).toBe(false);
  });
});
