// @vitest-environment jsdom
// The composer's position chip must never touch the draft while the user
// types: the pill is added only at the moment of submit.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { describe, expect, it } from "vitest";
import { isSubmitKey } from "../app/composer/ComposerParts";
import { cursorShownAfter, isTerminalReply } from "../app/surface/TreePane";

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

async function composerPart(kind: "banners" | "actions", id: string, settings: Record<string, string | number | boolean>, text = "") {
  const app = await loadPluginApp(() => import("../app"));
  const customization = app.composerCustomizations.find((c) => c.id === "helix")!;
  const part = customization[kind]!.find((b) => b.id === id)!;
  return renderSlot(part as never, {} as never, {
    rpc: { threadStatus: () => ({ instance, candidates: 1 }) },
    settings,
    composer: { scope: { kind: "thread", threadId: "thr_a" }, text },
  });
}

describe("editor position off by default", () => {
  it("shows no chip and adds nothing while the setting is off", async () => {
    const chip = await composerPart("banners", "position", { positionInMessages: false });
    await new Promise((r) => setTimeout(r, 50));
    expect(chip.queryByText("Sending position")).toBeNull();
    expect(chip.queryByText("Position off")).toBeNull();
    chip.lifecycle.unmount();
  });

  it("attaches the position to one message from the composer's button, and takes it out again", async () => {
    const slot = await composerPart("actions", "position", { positionInMessages: false }, "look at this");
    const button = await slot.findByRole("button", { name: /Attach your Helix position to this message \(main.go:12\)/u });
    expect(slot.inspection.composer.draft.mentions).toEqual([]);
    button.click();
    await slot.findByRole("button", { name: "Remove the Helix position from this message" });
    expect(slot.inspection.composer.draft.mentions).toMatchObject([{ kind: "plugin", provider: "position", id: "thr_a", label: "Helix position" }]);
    expect(slot.inspection.composer.text.startsWith("look at this ")).toBe(true);
    slot.getByRole("button", { name: "Remove the Helix position from this message" }).click();
    await slot.findByRole("button", { name: /Attach your Helix position/u });
    expect(slot.inspection.composer.draft.mentions).toEqual([]);
    expect(slot.inspection.composer.text).toBe("look at this");
    slot.lifecycle.unmount();
  });

  it("has no button while the position goes with every message", async () => {
    const slot = await composerPart("actions", "position", { positionInMessages: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(slot.queryByRole("button")).toBeNull();
    slot.lifecycle.unmount();
  });
});

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

describe("the file tree's input", () => {
  it("drops terminal replies, never keys", () => {
    for (const reply of ["\x1b]11;rgb:1515/1515/1515\x1b\\", "\x1b[?62;22c", "\x1b[?2026;2$y", "\x1b[?997;1n", "\x1b[12;40R", "\x1b[4;900;1440t", "\x1bP>|ghostty\x1b\\"]) expect(isTerminalReply(reply)).toBe(true);
    for (const key of ["j", "\x1b", "\x1b[A", "\x1b[1;3A", "\x1bx", "\r", "\x1b[15~", "\x1bOP", "\x1b[Z"]) expect(isTerminalReply(key)).toBe(false);
  });

  it("knows yazi is taking text from its cursor, so 1, 2, 3 and Escape are typed there", () => {
    const bytes = (text: string) => new TextEncoder().encode(text);
    expect(cursorShownAfter(bytes("\x1b[?25l\x1b[2;1Hfiles"), true)).toBe(false);
    expect(cursorShownAfter(bytes("\x1b[?25l\x1b[5;9HFind next:\x1b[?25h"), false)).toBe(true);
    expect(cursorShownAfter(bytes("\x1b[?25h\x1b[?25l"), true)).toBe(false);
    // Nothing about the cursor: as it was.
    expect(cursorShownAfter(bytes("\x1b[?2026h\x1b[1;1Hlist\x1b[?2026l"), true)).toBe(true);
    expect(cursorShownAfter(bytes("plain\x1b"), false)).toBe(false);
  });
});

describe("keys", () => {
  it("binds none of bb's shortcuts by default and leaves bb's sidebar alone", async () => {
    const app = await loadPluginApp(() => import("../app"));
    // The harness does not collect commands: the registrations are read as written.
    expect(readFileSync(join(process.cwd(), "app.tsx"), "utf8")).not.toMatch(/defaultShortcut\s*:/u);
    for (const panel of app.navPanels) expect((panel as { experimental_sidebar?: unknown }).experimental_sidebar).toBeUndefined();
  });

  it("hints every action from Helix as space and a key, with no Cmd, Option or Control", async () => {
    const { HELIX_KEYS } = await import("../app/keys");
    for (const row of HELIX_KEYS) for (const combo of row.keys) expect(combo).toMatch(/^space\+(e|u\+(shift\+)?[a-z])$/u);
  });

  it("goes back to Helix on Escape in the chat, unless bb used the key", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const { editorFocus } = await import("../app/rail/railStore");
    let focused = 0;
    editorFocus.set("thr_a", () => void focused++);
    const tab = app.tabs.find((t) => t.id === "chat")!;
    const view = await renderSlot(tab as never, { subPath: "thr_a" } as never, {});
    const inside = view.container.querySelector(".contents")!.firstElementChild ?? view.container.querySelector(".contents")!;
    inside.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(focused).toBe(1);
    const used = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    used.preventDefault();
    inside.dispatchEvent(used);
    inside.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }));
    expect(focused).toBe(1);
    editorFocus.delete("thr_a");
  });
});
