// @vitest-environment jsdom
// The file tree's flows, by the keyboard and the pointer, on the in-memory
// workspace the preview uses: moving, folders, search, create, rename, copy
// and move, trash, dot files, the memory across the rail closing, reveal, and
// fields that keep their keys to themselves.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileTree, type FileTreeHandle, type FileTreeProps } from "../app/files/FileTree";
import { resetFilesCache } from "../app/files/filesStore";
import { DRAG_TYPE, draggedRows, mentionParts } from "../app/files/handoff";
import { kindOf } from "../app/files/icons";
import { memoryLink } from "../app/files/memoryLink";
import { memorySource, type MemorySource, type MemoryWorkspace } from "../app/files/memorySource";
import { matcher } from "../app/files/model";
import { railMemory } from "../app/rail/railMemory";
import { editorFocus } from "../app/rail/railStore";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const workspace = (): MemoryWorkspace => ({
  ".git": { HEAD: null },
  ".bazelrc": null,
  cmd: { api: { "main.go": null } },
  docs: { "sessions.md": null, "session-notes.md": null },
  empty: {},
  secrets: { error: "Permission denied" },
  services: {
    auth: { "BUILD.bazel": null, "session.go": null, "Session_test.go": null, "token.go": null },
    billing: { "invoice.go": null },
  },
  "bazel-bin": { link: "cmd" },
  "BUILD.bazel": null,
  "go.mod": null,
  "README.md": null,
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let thread = 0;

interface Tree {
  source: MemorySource;
  threadId: string;
  handle: { current: FileTreeHandle | null };
  onLeave: ReturnType<typeof vi.fn>;
  list(): HTMLElement;
  cursor(): string;
  paths(): string[];
  press(key: string, init?: KeyboardEventInit, target?: Element | null): Promise<KeyboardEvent>;
  type(text: string, target?: HTMLInputElement | null): Promise<void>;
  field(): HTMLInputElement | null;
  search(): HTMLInputElement;
  unmount(): void;
  remount(): Promise<void>;
}

async function settle() {
  for (let i = 0; i < 4; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)));
}

async function mount(options: { source?: MemorySource; threadId?: string; props?: Partial<FileTreeProps> } = {}): Promise<Tree> {
  const source = options.source ?? memorySource(workspace());
  const threadId = options.threadId ?? `thr_files_${++thread}`;
  const handle: { current: FileTreeHandle | null } = { current: null };
  const onLeave = vi.fn();
  const render = async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(createElement(FileTree, { source, threadId, onLeave, handle, ...options.props })));
    await settle();
  };
  await render();
  const list = () => host!.querySelector<HTMLElement>("[data-files-list]")!;
  const tree: Tree = {
    source,
    threadId,
    handle,
    onLeave,
    list,
    cursor: () => list().dataset.cursor ?? "",
    paths: () => Array.from(host!.querySelectorAll<HTMLElement>("[data-path]")).sort((a, b) => Number(a.dataset.index) - Number(b.dataset.index)).map((el) => el.dataset.path!),
    async press(key, init = {}, target) {
      const el = target ?? document.activeElement ?? list();
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
      act(() => void el.dispatchEvent(event));
      await settle();
      return event;
    },
    async type(text, target) {
      const input = target ?? tree.field()!;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      act(() => {
        setter.call(input, text);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await settle();
    },
    field: () => host!.querySelector<HTMLInputElement>("[data-files-field]"),
    search: () => host!.querySelector<HTMLInputElement>("[data-files-search]")!,
    unmount() {
      act(() => root?.unmount());
      host?.remove();
      root = null;
    },
    async remount() {
      tree.unmount();
      await render();
    },
  };
  act(() => list().focus());
  return tree;
}

beforeEach(() => {
  resetFilesCache();
  Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn(() => Promise.resolve()) }, configurable: true });
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
});

/** Until `ok` holds (rendering as it goes), or fail after a second. */
async function waitFor(ok: () => boolean) {
  for (let i = 0; i < 100 && !ok(); i++) await act(async () => await new Promise((r) => setTimeout(r, 10)));
  expect(ok()).toBe(true);
}

async function keys(tree: Tree, ...sequence: string[]) {
  for (const k of sequence) await tree.press(k);
}

describe("the file tree", () => {
  it("lists the workspace, folders first, dot files hidden, and says what it cannot show", async () => {
    const tree = await mount();
    expect(tree.paths()).toEqual(["bazel-bin", "cmd", "docs", "empty", "secrets", "services", "BUILD.bazel", "go.mod", "README.md"]);
    expect(tree.cursor()).toBe("bazel-bin");
    // A link has its mark.
    expect(tree.list().querySelector('[data-path="bazel-bin"] [title="A link"]')).not.toBeNull();
    // An empty folder and an unreadable one say so in place.
    await keys(tree, "j", "j", "j", "l");
    expect(tree.list().textContent).toContain("Empty folder");
    await keys(tree, "j", "l");
    expect(tree.cursor()).toBe("secrets");
    expect(tree.list().textContent).toContain("Permission denied");
  });

  it("keeps the keyboard when the first listing arrives after the rail gave it focus", async () => {
    const source = memorySource(workspace(), { latency: 30 });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(createElement(FileTree, { source, threadId: "thr_files_cold" })));
    const list = host.querySelector<HTMLElement>("[data-files-list]")!;
    act(() => list.focus());
    expect(host.querySelector('[role="status"]')).not.toBeNull();
    await act(async () => await new Promise((r) => setTimeout(r, 60)));
    expect(host.querySelector("[data-files-list]")).toBe(list);
    expect(document.activeElement).toBe(list);
    expect(list.dataset.cursor).toBe("bazel-bin");
  });

  it("moves with j, k, g g, G, and opens and closes folders with l and h", async () => {
    const tree = await mount();
    await keys(tree, "j", "j");
    expect(tree.cursor()).toBe("docs");
    await keys(tree, "k");
    expect(tree.cursor()).toBe("cmd");
    await keys(tree, "G");
    expect(tree.cursor()).toBe("README.md");
    await keys(tree, "g", "g");
    expect(tree.cursor()).toBe("bazel-bin");
    // l opens services, l again goes to its first child, h goes back to the parent, h closes it.
    await keys(tree, "G", "k", "k", "k");
    expect(tree.cursor()).toBe("services");
    await keys(tree, "l");
    expect(tree.paths()).toContain("services/auth");
    await keys(tree, "l");
    expect(tree.cursor()).toBe("services/auth");
    await keys(tree, "l", "l");
    expect(tree.cursor()).toBe("services/auth/BUILD.bazel");
    await keys(tree, "h");
    expect(tree.cursor()).toBe("services/auth");
    await keys(tree, "h");
    expect(tree.paths()).not.toContain("services/auth/session.go");
    await keys(tree, "h");
    expect(tree.cursor()).toBe("services");
    await keys(tree, "h");
    expect(tree.paths()).not.toContain("services/auth");
  });

  it("opens a file in Helix with Enter and closes the rail, unless it stays open", async () => {
    const focus = vi.fn();
    const tree = await mount();
    editorFocus.set(tree.threadId, focus);
    await keys(tree, "G", "Enter");
    expect(tree.source.calls.filter((c) => c.method === "open").map((c) => c.path)).toEqual(["README.md"]);
    expect(tree.onLeave).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalled();
    const kept = await mount({ props: { staysOpen: true } });
    await keys(kept, "G", "Enter");
    expect(kept.onLeave).not.toHaveBeenCalled();
  });

  it("reads every folder it needs in one list, and prefetches a folder the cursor rests on", async () => {
    const tree = await mount();
    const lists = () => tree.source.calls.filter((c) => c.method === "list");
    expect(lists().map((c) => c.dirs)).toEqual([[""]]);
    await keys(tree, "G", "k", "k", "k");
    await act(async () => await new Promise((r) => setTimeout(r, 90)));
    expect(lists().at(-1)?.dirs).toEqual(["services"]);
    const before = lists().length;
    await keys(tree, "l");
    // Already prefetched: drawn at once, read again behind.
    expect(tree.paths()).toContain("services/auth");
    expect(lists().length).toBe(before + 1);
  });

  it("searches what is loaded, narrows the tree, marks the letters, and Escape goes back", async () => {
    const tree = await mount();
    await keys(tree, "G", "k", "k", "k", "l", "j", "l");
    act(() => tree.handle.current!.reveal("services/billing/invoice.go"));
    await settle();
    await keys(tree, "g", "g");
    expect(tree.cursor()).toBe("bazel-bin");
    const slash = await tree.press("/");
    expect(slash.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(tree.search());
    await tree.type("sess", tree.search());
    // The host's order (natural, case ignored): Session_test.go, then session.go.
    expect(tree.paths()).toEqual(["services", "services/auth", "services/auth/Session_test.go", "services/auth/session.go"]);
    expect(tree.list().querySelector('[data-path="services/auth/session.go"] mark')?.textContent).toBe("sess");
    // docs was never opened, so its sessions.md is not searched.
    expect(tree.paths()).not.toContain("docs/sessions.md");
    expect(tree.cursor()).toBe("services/auth/Session_test.go");
    // Smart case: a capital letter matches case.
    await tree.type("Sess", tree.search());
    expect(tree.paths()).toEqual(["services", "services/auth", "services/auth/Session_test.go"]);
    // Escape in the field clears it and the cursor is back where it was.
    await tree.press("Escape", {}, tree.search());
    expect(tree.search().value).toBe("");
    expect(tree.cursor()).toBe("bazel-bin");
    expect(document.activeElement).toBe(tree.list());
    // Down goes into the results; Escape in the list leaves the search on that row, its folders open.
    act(() => tree.search().focus());
    await tree.type("tok", tree.search());
    await tree.press("ArrowDown", {}, tree.search());
    expect(document.activeElement).toBe(tree.list());
    expect(tree.cursor()).toBe("services/auth/token.go");
    await tree.press("Escape");
    expect(tree.search().value).toBe("");
    expect(tree.cursor()).toBe("services/auth/token.go");
    expect(tree.paths()).toContain("services/billing");
    expect(tree.onLeave).not.toHaveBeenCalled();
    // Nothing found says so.
    act(() => tree.search().focus());
    await tree.type("zzz", tree.search());
    expect(tree.list().textContent).toContain("Nothing matches “zzz”");
  });

  it("matches the parts of a query in order", () => {
    const match = matcher("ses go")!;
    expect(match("session.go")).toEqual([0, 3, 8, 10]);
    expect(match("go_session")).toBeNull();
    expect(matcher("  ")).toBeNull();
  });

  it("creates a file, a folder, and the folders on the way, in a field in place", async () => {
    const tree = await mount();
    await keys(tree, "j", "j", "l"); // docs, open
    await keys(tree, "a");
    expect(tree.field()).not.toBeNull();
    expect(document.activeElement).toBe(tree.field());
    expect(tree.list().querySelector("[data-draft]")).not.toBeNull();
    await tree.type("plan.md");
    // The draft's icon follows the extension as it is typed.
    expect(tree.list().querySelector("[data-draft] svg")?.getAttribute("data-kind")).toBe("Markdown");
    await tree.press("Enter", {}, tree.field());
    expect(tree.source.exists("docs/plan.md")).toBe(true);
    expect(tree.cursor()).toBe("docs/plan.md");
    expect(document.activeElement).toBe(tree.list());

    // A folder with A (the cursor is on a file of docs: docs is its folder).
    await keys(tree, "A");
    await tree.type("adr");
    await tree.press("Enter", {}, tree.field());
    expect(tree.source.exists("docs/adr")).toBe(true);
    expect(tree.cursor()).toBe("docs/adr");

    // a/b/c.go makes the folders on the way; the cursor lands on the file with its folders open.
    await keys(tree, "g", "g", "a");
    await tree.type("pkg/clock/clock.go");
    await tree.press("Enter", {}, tree.field());
    expect(tree.source.exists("pkg/clock/clock.go")).toBe(true);
    expect(tree.cursor()).toBe("pkg/clock/clock.go");
    expect(tree.paths()).toEqual(expect.arrayContaining(["pkg", "pkg/clock", "pkg/clock/clock.go"]));

    // A name ending in / is a folder.
    await keys(tree, "a");
    await tree.type("testdata/");
    await tree.press("Enter", {}, tree.field());
    expect(tree.source.exists("pkg/clock/testdata")).toBe(true);
    expect(tree.list().querySelector('[data-path="pkg/clock/testdata"]')?.getAttribute("aria-expanded")).toBe("false");

    // Escape drops the draft and creates nothing.
    const ops = tree.source.calls.filter((c) => c.method === "op").length;
    await keys(tree, "a");
    await tree.type("nope.go");
    await tree.press("Escape", {}, tree.field());
    expect(tree.field()).toBeNull();
    expect(tree.source.calls.filter((c) => c.method === "op").length).toBe(ops);
    expect(tree.onLeave).not.toHaveBeenCalled();
  });

  it("says a name is taken before asking the host, and keeps the field", async () => {
    const tree = await mount();
    await keys(tree, "a");
    await tree.type("go.mod");
    await tree.press("Enter", {}, tree.field());
    expect(tree.field()).not.toBeNull();
    expect(document.querySelector("[data-files-notice=error]")?.textContent).toContain("go.mod is already there");
    expect(tree.source.calls.some((c) => c.method === "op")).toBe(false);
  });

  it("renames in place with the name before its extension selected, and on F2", async () => {
    const tree = await mount();
    await keys(tree, "G", "r");
    const field = tree.field()!;
    expect(field.value).toBe("README.md");
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, 6]);
    await tree.type("GUIDE.md");
    await tree.press("Enter", {}, field);
    expect(tree.source.exists("GUIDE.md")).toBe(true);
    expect(tree.source.exists("README.md")).toBe(false);
    expect(tree.cursor()).toBe("GUIDE.md");
    // A folder renamed keeps its open folders under the new name.
    await keys(tree, "g", "g", "j", "j", "j", "j", "j");
    expect(tree.cursor()).toBe("services");
    await keys(tree, "l", "j", "l");
    await keys(tree, "k", "F2");
    await tree.type("svc");
    await tree.press("Enter", {}, tree.field());
    expect(tree.source.exists("svc/auth/token.go")).toBe(true);
    expect(tree.paths()).toContain("svc/auth/token.go");
    // A taken name is refused by the host and the row goes back.
    await keys(tree, "G", "k");
    expect(tree.cursor()).toBe("go.mod");
    tree.source.failNext("rename", "go.sum already exists");
    await keys(tree, "r");
    await tree.type("go.sum");
    await tree.press("Enter", {}, tree.field());
    expect(document.querySelector("[data-files-notice=error]")?.textContent).toContain("go.sum already exists");
    expect(tree.paths()).toContain("go.mod");
    expect(tree.paths()).not.toContain("go.sum");
    expect(tree.cursor()).toBe("go.mod");
  });

  it("copies the selection and pastes into the cursor's folder; a taken name gets _1", async () => {
    const tree = await mount();
    // Space selects and goes down: go.mod and README.md.
    await keys(tree, "G", "k", " ", " ");
    expect(tree.list().querySelectorAll("[data-selected]").length).toBe(2);
    await keys(tree, "y");
    expect(document.querySelector("[data-files-clip=copy]")?.textContent).toContain("2 items to copy");
    expect(tree.list().querySelectorAll("[data-selected]").length).toBe(0);
    // Into docs (open), then again into the workspace itself: names are taken there.
    await keys(tree, "g", "g", "j", "j", "l", "p");
    expect(tree.source.exists("docs/go.mod")).toBe(true);
    expect(tree.source.exists("docs/README.md")).toBe(true);
    expect(tree.cursor()).toBe("docs/go.mod");
    // The clip stays for another paste.
    await keys(tree, "G", "p");
    expect(tree.source.exists("go_1.mod")).toBe(true);
    expect(tree.source.exists("README_1.md")).toBe(true);
    expect(tree.paths()).toEqual(expect.arrayContaining(["go_1.mod", "README_1.md"]));
    // Cmd+C, Cmd+V do the same.
    await keys(tree, "g", "g", "j", "j", "j");
    expect(tree.cursor()).toBe("docs/go.mod");
    await tree.press("c", { metaKey: true, ctrlKey: true });
    expect(document.querySelector("[data-files-clip=copy]")?.textContent).toContain("go.mod to copy");
    // Escape drops what waits to be pasted, and does not close the rail.
    await tree.press("Escape");
    expect(document.querySelector("[data-files-clip]")).toBeNull();
    expect(tree.onLeave).not.toHaveBeenCalled();
  });

  it("cuts and pastes, dims what is cut, and refuses a folder into itself", async () => {
    const tree = await mount();
    await keys(tree, "G", "x");
    expect(tree.list().querySelector('[data-path="README.md"]')?.hasAttribute("data-cut")).toBe(true);
    await keys(tree, "g", "g", "j", "j", "l", "p");
    expect(tree.source.exists("docs/README.md")).toBe(true);
    expect(tree.source.exists("README.md")).toBe(false);
    expect(tree.cursor()).toBe("docs/README.md");
    expect(document.querySelector("[data-files-clip]")).toBeNull();
    // docs cut, pasted while the cursor is inside docs.
    await keys(tree, "k", "x", "j", "p");
    expect(document.querySelector("[data-files-notice=error]")?.textContent).toContain("docs cannot go inside itself");
    expect(tree.source.exists("docs")).toBe(true);
  });

  it("trashes after asking in words; Escape keeps the file; a refusal puts the row back", async () => {
    const tree = await mount();
    await keys(tree, "G", "d");
    const bar = document.querySelector("[data-files-confirm=trash]");
    expect(bar?.textContent).toContain("Move README.md to the trash?");
    expect(document.activeElement?.hasAttribute("data-files-confirm-yes")).toBe(true);
    // No list key acts while the bar asks.
    await tree.press("j");
    expect(tree.cursor()).toBe("README.md");
    await tree.press("Escape");
    expect(document.querySelector("[data-files-confirm]")).toBeNull();
    expect(tree.source.exists("README.md")).toBe(true);
    expect(tree.onLeave).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(tree.list());

    await keys(tree, "Backspace");
    act(() => document.querySelector<HTMLButtonElement>("[data-files-confirm-yes]")!.click());
    await settle();
    expect(tree.source.exists("README.md")).toBe(false);
    expect(tree.paths()).not.toContain("README.md");
    expect(tree.cursor()).toBe("go.mod");

    tree.source.failNext("trash", "go.mod is on another volume than the trash; D deletes it for good");
    await keys(tree, "d");
    act(() => document.querySelector<HTMLButtonElement>("[data-files-confirm-yes]")!.click());
    await settle();
    expect(document.querySelector("[data-files-notice=error]")?.textContent).toContain("D deletes it for good");
    expect(tree.paths()).toContain("go.mod");
    expect(tree.cursor()).toBe("go.mod");

    // D asks differently and deletes for good.
    await keys(tree, "D");
    expect(document.querySelector("[data-files-confirm=delete]")?.textContent).toContain("Delete go.mod for good?");
    act(() => document.querySelector<HTMLButtonElement>("[data-files-confirm-yes]")!.click());
    await settle();
    expect(tree.source.calls.filter((c) => c.method === "op").at(-1)?.op).toEqual({ kind: "delete", paths: ["go.mod"] });
  });

  it("shows and hides dot files with .", async () => {
    const tree = await mount();
    expect(tree.paths()).not.toContain(".bazelrc");
    await keys(tree, ".");
    expect(tree.paths().slice(0, 2)).toEqual([".git", "bazel-bin"]);
    expect(tree.paths()).toContain(".bazelrc");
    await keys(tree, ".");
    expect(tree.paths()).not.toContain(".git");
  });

  it("copies the row's path with c, absolute when the workspace's root is known", async () => {
    const tree = await mount({ props: { root: "/src/repo" } });
    await keys(tree, "G", "c");
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("/src/repo/README.md");
  });

  it("comes back where it was after the rail closes: open folders, cursor, dot files, from the cache at once", async () => {
    const tree = await mount();
    await keys(tree, "G", "k", "k", "k", "l", "j", "l", "j", "j", ".");
    expect(tree.cursor()).toBe("services/auth/Session_test.go");
    const lists = tree.source.calls.filter((c) => c.method === "list").length;
    tree.unmount();
    // The cache draws the first frame: the rows are there before any read.
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(createElement(FileTree, { source: tree.source, threadId: tree.threadId })));
    expect(host.querySelector<HTMLElement>("[data-files-list]")!.dataset.cursor).toBe("services/auth/Session_test.go");
    await settle();
    // Then every open folder is read again in one list.
    const after = tree.source.calls.filter((c) => c.method === "list").slice(lists);
    expect(after.length).toBe(1);
    expect(new Set(after[0]!.dirs)).toEqual(new Set(["", "services", "services/auth"]));
    expect(railMemory(tree.threadId).files.showHidden).toBe(true);
  });

  it("follows a row it remembers when it was moved away while the rail was closed", async () => {
    const tree = await mount();
    await keys(tree, "G");
    expect(tree.cursor()).toBe("README.md");
    tree.unmount();
    tree.source.external({ kind: "delete", paths: ["README.md"] });
    await tree.remount();
    expect(tree.cursor()).toBe("go.mod");
  });

  it("reveals a deep file: its folders open in one list, the cursor on it", async () => {
    const tree = await mount();
    const lists = tree.source.calls.filter((c) => c.method === "list").length;
    act(() => tree.handle.current!.reveal("services/auth/token.go"));
    await settle();
    expect(tree.cursor()).toBe("services/auth/token.go");
    const after = tree.source.calls.filter((c) => c.method === "list").slice(lists);
    expect(after.map((c) => c.dirs)).toEqual([["services", "services/auth"]]);
    // A dot file shows dot files.
    act(() => tree.handle.current!.reveal(".git/HEAD"));
    await settle();
    expect(tree.cursor()).toBe(".git/HEAD");
  });

  it("reads again what changed outside the tree", async () => {
    const tree = await mount();
    tree.source.external({ kind: "create", path: "NOTES.md" }, [""]);
    await settle();
    expect(tree.paths()).toContain("NOTES.md");
    tree.source.external({ kind: "create", path: "CHANGELOG.md" }, null);
    await settle();
    expect(tree.paths()).toContain("CHANGELOG.md");
  });

  it("keeps a field's keys to the field: no list key fires while a name is typed", async () => {
    const tree = await mount();
    await keys(tree, "a");
    const field = tree.field()!;
    for (const k of ["j", "k", "d", "y", "p", ".", "G", " ", "/", "1"]) {
      const event = await tree.press(k, {}, field);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(tree.cursor()).toBe("");
    expect(tree.paths()).not.toContain(".bazelrc");
    expect(document.querySelector("[data-files-confirm]")).toBeNull();
    expect(document.activeElement).toBe(field);
    // The search field too.
    await tree.press("Escape", {}, field);
    act(() => tree.search().focus());
    const j = await tree.press("j", {}, tree.search());
    expect(j.defaultPrevented).toBe(false);
  });

  it("leaves the rail's own keys alone, and Escape steps back before it closes", async () => {
    const tree = await mount();
    for (const k of ["1", "2", "3", "?"]) expect((await tree.press(k)).defaultPrevented).toBe(false);
    expect((await tree.press("C", { shiftKey: true })).defaultPrevented).toBe(false);
    expect((await tree.press("j")).defaultPrevented).toBe(true);
    await keys(tree, " ");
    await tree.press("Escape");
    expect(tree.list().querySelectorAll("[data-selected]").length).toBe(0);
    expect(tree.onLeave).not.toHaveBeenCalled();
    await tree.press("Escape");
    expect(tree.onLeave).toHaveBeenCalledTimes(1);
  });

  it("selects a range with Shift and with the pointer, and opens a folder on a click", async () => {
    const tree = await mount();
    await keys(tree, "G");
    await tree.press("K", { shiftKey: true });
    await tree.press("K", { shiftKey: true });
    expect(Array.from(tree.list().querySelectorAll<HTMLElement>("[data-selected]")).map((e) => e.dataset.path)).toEqual(["BUILD.bazel", "go.mod", "README.md"]);
    await tree.press("j");
    await tree.press("Escape");
    const docs = tree.list().querySelector<HTMLElement>('[data-path="docs"]')!;
    act(() => {
      docs.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      docs.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
    });
    await settle();
    expect(tree.cursor()).toBe("docs");
    expect(tree.paths()).toContain("docs/sessions.md");
    const readme = tree.list().querySelector<HTMLElement>('[data-path="README.md"]')!;
    act(() => readme.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, metaKey: true, ctrlKey: true })));
    await settle();
    expect(tree.list().querySelector('[data-path="README.md"]')?.hasAttribute("data-selected")).toBe(true);
  });

  it("offers the actions by name in the row menu, with their keys", async () => {
    const tree = await mount();
    await keys(tree, "G");
    const row = tree.list().querySelector<HTMLElement>('[data-path="README.md"]')!;
    act(() => void row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 80 })));
    await settle();
    const menu = document.querySelector<HTMLElement>("[data-files-menu]")!;
    expect(Array.from(menu.querySelectorAll('[role="menuitem"]')).map((i) => i.firstChild?.textContent)).toEqual(["New file", "New folder", "Rename", "Copy", "Cut", "Paste", "Copy path", "Show dot files", "Move to trash"]);
    expect(document.activeElement).toBe(menu);
    // Down to Rename, Enter: the row's name is a field.
    await tree.press("ArrowDown", {}, menu);
    await tree.press("ArrowDown", {}, menu);
    await tree.press("Enter", {}, menu);
    expect(tree.field()?.value).toBe("README.md");
  });

  it("carries the review's status letters and marks the folders that hold changes", async () => {
    const tree = await mount({ props: { changes: [{ path: "services/auth/token.go", status: "modified" }, { path: "go.mod", status: "added" }] } });
    expect(tree.list().querySelector('[data-path="go.mod"]')?.textContent).toContain("A");
    expect(tree.list().querySelector('[data-path="services"] [aria-label="Has changes"]')).not.toBeNull();
  });

  it("tells the kinds of file apart by name and extension", () => {
    expect(kindOf("session.go")?.label).toBe("Go");
    expect(kindOf("BUILD.bazel")?.label).toBe("Bazel");
    expect(kindOf("BUILD")?.label).toBe("Bazel");
    expect(kindOf("deps.bzl")?.label).toBe("Bazel");
    expect(kindOf("go.mod")?.label).toBe("Go module");
    expect(kindOf("App.tsx")?.label).toBe("TypeScript");
    expect(kindOf("Dockerfile.dev")?.label).toBe("Docker");
    expect(kindOf("notes")).toBeNull();
  });

  it("draws a cursor move without drawing the other rows again, with 5 000 rows", async () => {
    const corpus: MemoryWorkspace = {};
    for (let i = 0; i < 5000; i++) corpus[`doc_${String(i).padStart(5, "0")}.json`] = null;
    const tree = await mount({ source: memorySource({ corpus }) });
    await keys(tree, "l");
    expect(tree.list().dataset.rows).toBe("5001");
    // Only the rows in view are in the document.
    expect(tree.list().querySelectorAll("[data-path]").length).toBeLessThan(100);
    const before = new Map(Array.from(tree.list().querySelectorAll<HTMLElement>("[data-path]")).map((el) => [el.dataset.path, el.innerHTML]));
    await keys(tree, "j");
    const changed = Array.from(tree.list().querySelectorAll<HTMLElement>("[data-path]")).filter((el) => before.get(el.dataset.path) !== el.innerHTML);
    expect(changed.map((el) => el.dataset.path)).toEqual(["corpus", "corpus/doc_00000.json"]);
    // And it adds or removes no element: in bb's page each one costs a style pass of about 8 ms.
    const added: Node[] = [];
    const observer = new MutationObserver((records) => records.forEach((r) => added.push(...Array.from(r.addedNodes), ...Array.from(r.removedNodes))));
    observer.observe(tree.list(), { childList: true, subtree: true });
    await keys(tree, "j", "j", "k");
    observer.disconnect();
    expect(added).toEqual([]);
    // (Scrolling, which jsdom cannot do, is measured in Chrome: app/files/measure.mjs.)
  });
});

describe("the tree and the agent", () => {
  const withLink = async (options: Parameters<typeof memoryLink>[1] = {}, props: Partial<FileTreeProps> = {}) => {
    const source = memorySource(workspace());
    const link = memoryLink(source, { writeMs: 20, ...options });
    const tree = await mount({ source, props: { link, ...props } });
    return { tree, link };
  };

  it("sends the row, or the selection, to the thread's composer as mentions, folders marked as folders", async () => {
    const { tree, link } = await withLink();
    await keys(tree, "G", "s");
    expect(link.mentioned).toEqual([["README.md"]]);
    expect(document.querySelector("[data-files-notice=info]")?.textContent).toContain("Sent to Split session errors");
    // The chat has the keyboard: the rail goes away (without giving Helix the keyboard).
    expect(tree.onLeave).toHaveBeenCalledTimes(1);
    await keys(tree, "g", "g", "j", " ", " ", "s");
    expect(link.mentioned[1]).toEqual(["cmd/", "docs/"]);
    expect(mentionParts(["docs/", "go.mod"])).toEqual([
      { from: 0, to: 0, label: "docs", kind: "path", path: "docs", source: "workspace", entryKind: "directory" },
      " ",
      { from: 0, to: 0, label: "go.mod", kind: "path", path: "go.mod", source: "workspace", entryKind: "file" },
      " ",
    ]);
  });

  it("says why when the composer does not take them, and keeps the rail", async () => {
    const { tree, link } = await withLink();
    link.failNext("mention", "The chat did not open");
    await keys(tree, "s");
    expect(document.querySelector("[data-files-notice=error]")?.textContent).toContain("The chat did not open");
    expect(tree.onLeave).not.toHaveBeenCalled();
  });

  it("asks about a row in a box with ready questions that fit it", async () => {
    const { tree, link } = await withLink();
    await keys(tree, "G", "i");
    const box = document.querySelector<HTMLElement>("[data-files-ask]")!;
    expect(box.getAttribute("aria-label")).toBe("Ask about README.md");
    const field = box.querySelector<HTMLInputElement>("[data-files-ask-field]")!;
    expect(document.activeElement).toBe(field);
    const chips = Array.from(box.querySelectorAll("[data-files-ask-chip]")).map((c) => c.textContent);
    expect(chips).toEqual(["Explain this file", "Who uses it?", "Write its tests", "Review it"]);
    // No list key fires while the question is typed.
    for (const k of ["j", "d", "s"]) expect((await tree.press(k, {}, field)).defaultPrevented).toBe(false);
    expect(tree.cursor()).toBe("README.md");
    // A chip fills the field; Enter sends it.
    act(() => (box.querySelectorAll<HTMLButtonElement>("[data-files-ask-chip]")[1]!).click());
    await settle();
    expect(field.value).toBe("Who uses it?");
    await tree.press("Enter", {}, field);
    expect(link.asked).toEqual([{ paths: ["README.md"], text: "Who uses it?" }]);
    expect(document.querySelector("[data-files-ask]")).toBeNull();
    expect(tree.onLeave).toHaveBeenCalledTimes(1);
  });

  it("offers folder questions on a folder, and Escape drops the question", async () => {
    const { tree, link } = await withLink();
    await keys(tree, "j", "i");
    const box = document.querySelector<HTMLElement>("[data-files-ask]")!;
    expect(Array.from(box.querySelectorAll("[data-files-ask-chip]")).map((c) => c.textContent)[0]).toBe("What is in here?");
    await tree.type("why so many?", box.querySelector<HTMLInputElement>("[data-files-ask-field]"));
    await tree.press("Escape", {}, box.querySelector("[data-files-ask-field]"));
    expect(document.querySelector("[data-files-ask]")).toBeNull();
    expect(link.asked).toEqual([]);
    expect(tree.onLeave).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(tree.list());
  });

  it("has a new file written by the agent: Tab to say what, a row while it is written, then Helix opens it", async () => {
    const { tree, link } = await withLink();
    await keys(tree, "j", "j", "l", "a");
    await tree.type("plan.md");
    await tree.press("Tab", {}, tree.field());
    const about = document.querySelector<HTMLInputElement>('[data-draft="about"] input')!;
    expect(document.activeElement).toBe(about);
    // Shift between the fields keeps the draft.
    expect(tree.list().querySelector("[data-draft] input")).not.toBeNull();
    await tree.type("The rollout plan for the session split", about);
    await tree.press("Enter", {}, about);
    expect(link.written).toEqual([{ path: "docs/plan.md", description: "The rollout plan for the session split" }]);
    expect(tree.source.calls.some((c) => c.method === "op")).toBe(false);
    const row = tree.list().querySelector<HTMLElement>('[data-path="docs/plan.md"]')!;
    expect(row.dataset.state).toBe("writing");
    expect(row.textContent).toContain("being written");
    // The agent writes it; the end of its turn says files changed.
    await waitFor(() => tree.list().querySelector<HTMLElement>('[data-path="docs/plan.md"]')?.dataset.state === undefined);
    expect(tree.source.calls.filter((c) => c.method === "open").map((c) => c.path)).toEqual(["docs/plan.md"]);
  });

  it("shows the agent's trail, live while it runs, on files and closed folders, and t narrows to it", async () => {
    const { tree, link } = await withLink();
    act(() =>
      link.setAgent({
        running: true,
        files: [
          { path: "services/auth/token.go", change: "edited", turn: "running" },
          { path: "docs/sessions.md", change: "edited", turn: "last" },
          { path: "old.go", change: "deleted", turn: "last" },
        ],
      }),
    );
    await settle();
    const dot = (path: string) => tree.list().querySelector<HTMLElement>(`[data-path="${path}"] .helix-files-agent-dot`)!;
    expect(dot("services").classList.contains("hidden")).toBe(false);
    expect(dot("services").classList.contains("helix-files-agent-live")).toBe(true);
    expect(dot("docs").classList.contains("helix-files-agent-live")).toBe(false);
    expect(dot("cmd").classList.contains("hidden")).toBe(true);
    expect(document.querySelector("[data-files-agent-chip]")?.textContent).toContain("3changing now");
    await keys(tree, "t");
    expect(tree.paths()).toEqual(["docs", "docs/sessions.md", "services", "services/auth", "services/auth/token.go", "old.go"]);
    expect(tree.cursor()).toBe("docs/sessions.md");
    await keys(tree, "G", "Enter");
    expect(document.querySelector("[data-files-notice]")?.textContent).toContain("The agent deleted old.go");
    await keys(tree, "k", "t");
    // Back to the whole tree on that row, its folders open.
    expect(tree.cursor()).toBe("services/auth/token.go");
    expect(tree.paths()).toContain("services/billing");
    // Escape steps out of the trail before it closes anything.
    await keys(tree, "t", "Escape");
    expect(tree.paths()).toContain("go.mod");
    expect(tree.onLeave).not.toHaveBeenCalled();
    // The turn ends: the marks stay, still.
    act(() => link.setAgent({ running: false, files: [{ path: "services/auth/token.go", change: "edited", turn: "last" }] }));
    await settle();
    expect(dot("services/auth/token.go").classList.contains("helix-files-agent-live")).toBe(false);
    expect(dot("services/auth/token.go").classList.contains("hidden")).toBe(false);
  });

  it("follows a fake turn as it runs", async () => {
    const { tree, link } = await withLink();
    const turn = link.turn([[{ path: "go.mod", change: "edited" }], [{ path: "cmd/api/new.go", change: "created" }]], 40);
    await waitFor(() => tree.list().querySelector('[data-path="go.mod"] .helix-files-agent-live') !== null);
    await act(async () => await turn);
    await settle();
    expect(tree.source.exists("cmd/api/new.go")).toBe(true);
    expect(tree.list().querySelector('[data-path="go.mod"] .helix-files-agent-live')).toBeNull();
    expect(tree.list().querySelector('[data-path="cmd"] .helix-files-agent-dot:not(.hidden)')).not.toBeNull();
  });

  it("marks files not viewed and open comments, and adds them up on closed folders", async () => {
    const { tree } = await withLink(
      {},
      {
        changes: [
          { path: "services/auth/token.go", status: "modified", viewed: false },
          { path: "services/auth/session.go", status: "modified", viewed: true },
          { path: "go.mod", status: "modified", viewed: false },
        ],
        comments: [
          { path: "services/auth/token.go", state: "unsent" },
          { path: "services/auth/token.go", state: "answered" },
          { path: "services/auth/session.go", state: "done" },
        ],
      },
    );
    const services = tree.list().querySelector<HTMLElement>('[data-path="services"]')!;
    expect(services.querySelector('[aria-label="1 not viewed"]')).not.toBeNull();
    expect(services.querySelector('[title="2 open comments inside"]')?.textContent).toBe("2");
    expect(tree.list().querySelector('[data-path="go.mod"] [aria-label="Not viewed"]')).not.toBeNull();
    act(() => tree.handle.current!.reveal("services/auth/token.go"));
    await settle();
    const token = tree.list().querySelector<HTMLElement>('[data-path="services/auth/token.go"]')!;
    expect(token.querySelector('[title="2 open comments"]')?.textContent).toBe("2");
    expect(tree.list().querySelector('[data-path="services/auth/session.go"] [title*="open comment"]')).toBeNull();
    // An open folder does not repeat what its rows show.
    expect(tree.list().querySelector<HTMLElement>('[data-path="services"] .helix-files-unviewed')?.classList.contains("hidden")).toBe(true);
  });

  it("starts a new thread on a folder, from the row menu only, and only when bb can", async () => {
    const { tree, link } = await withLink();
    await keys(tree, "j", "ContextMenu");
    const items = () => Array.from(document.querySelectorAll('[data-files-menu] [role="menuitem"]')).map((i) => i.firstChild?.textContent);
    expect(items()).toContain("New thread here");
    act(() => Array.from(document.querySelectorAll<HTMLElement>('[data-files-menu] [role="menuitem"]')).find((i) => i.textContent?.startsWith("New thread here"))!.click());
    await settle();
    expect(link.mentioned).toEqual([["new-thread", "cmd/"]]);
    await keys(tree, "G", "ContextMenu");
    expect(items()).not.toContain("New thread here");
    expect(items().slice(0, 2)).toEqual(["Send to thread", "Ask about it"]);
    const without = await withLink({ newThread: false });
    await keys(without.tree, "j", "ContextMenu");
    expect(items()).not.toContain("New thread here");
  });

  it("drags rows as mentions for the chat's drop place, with no text that would paste as plain paths", async () => {
    const { tree } = await withLink();
    const row = tree.list().querySelector<HTMLElement>('[data-path="docs"]')!;
    expect(row.getAttribute("draggable")).toBe("true");
    const data = new Map<string, string>();
    const event = new Event("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { setData: (t: string, v: string) => data.set(t, v), effectAllowed: "" } });
    act(() => void row.dispatchEvent(event));
    expect(JSON.parse(data.get(DRAG_TYPE)!)).toEqual(["docs/"]);
    expect(data.has("text/plain")).toBe(false);
    expect(draggedRows.get()).toEqual(["docs/"]);
    act(() => void row.dispatchEvent(new Event("dragend", { bubbles: true })));
    expect(draggedRows.get()).toBeNull();
  });

  it("offers none of it without a thread", async () => {
    const tree = await mount();
    for (const k of ["s", "i", "t"]) expect((await tree.press(k)).defaultPrevented).toBe(false);
    expect(document.querySelector("[data-files-ask]")).toBeNull();
    expect(tree.list().querySelector('[data-path="docs"]')?.getAttribute("draggable")).toBeNull();
  });
});
