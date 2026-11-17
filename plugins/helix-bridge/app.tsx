// Helix Bridge frontend.
//
// The editor lives on its own page (`/plugins/helix-bridge/editor/<thread>`)
// with the thread's chat in the page's side panel, and as a quick-look tab on
// threads. The thread context card shows where the user is; the composer can
// carry that position; drafts from Helix land in the composer.
import {
  definePluginApp,
  experimental_THREAD_ACTION_GROUPS as ACTION_GROUPS,
  experimental_THREAD_INFO_ROW_GROUPS as ROW_GROUPS,
} from "@get-bb/plugin-sdk/app";
import { FromHelixReceipt, PositionAction, PositionChip } from "./app/composer/ComposerParts";
import { HelixOverlay } from "./app/overlay/HelixOverlay";
import { EditorRail } from "./app/rail/Rail";
import { commandRequest } from "./app/stores";
import { pageActions } from "./app/pages/pageActions";
import { useReviewSummaries } from "./app/data";
import { railTab } from "./app/rail/railStore";
import { ChatTab, EDITOR_PANEL, EditorHeader, EditorPage } from "./app/pages/EditorPage";
import { surfaceControls, visibleSurfaces } from "./app/surface/EditorSurface";
import { HelixSegment, HelixStatusRow, HelixTab, useHelixSegmentVisible } from "./app/thread/ThreadParts";

function focusEditor(): boolean {
  const surface = [...visibleSurfaces.values()].find((el) => el.isConnected);
  const input = surface?.querySelector<HTMLElement>("textarea, [contenteditable], [tabindex]");
  input?.focus();
  return Boolean(input);
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: EDITOR_PANEL,
    title: "Helix",
    icon: "Code",
    path: EDITOR_PANEL,
    component: EditorPage,
    headerContent: EditorHeader,
    experimental_sidebar: EditorRail,
  });

  app.slots.experimental_tab({
    context: { kind: "nav-panel", panelId: EDITOR_PANEL },
    availability: "fixed",
    id: "chat",
    title: "Chat",
    icon: "MessageSquare",
    tooltip: "The thread's conversation beside the editor",
    component: ChatTab,
    layout: "flush",
  });

  app.slots.experimental_tab({
    context: { kind: "thread" },
    availability: "action",
    id: "helix",
    title: "Helix",
    icon: "Code",
    tooltip: "This thread's editor, for a quick look",
    component: HelixTab,
    layout: "flush",
  });

  app.slots.experimental_threadContextCardRow({ id: "helix", group: ROW_GROUPS.environment, order: 60, component: HelixStatusRow });

  app.slots.experimental_threadContextSegment({ id: "helix", title: "Helix", group: "2_helix", summary: HelixSegment, useVisible: useHelixSegmentVisible });

  app.slots.experimental_threadAction({
    id: "open-editor",
    title: "Open Helix",
    icon: "Code",
    group: ACTION_GROUPS.open,
    placement: "header",
    // The thread's editor; while a review has files not viewed, the button
    // says how many and opens the page on Changes.
    useData: ({ threadIds }) => useReviewSummaries(threadIds),
    item: ({ thread, navigate, data }) => {
      const unviewed = data?.[thread.id]?.unviewed ?? 0;
      return {
        label: unviewed > 0 ? `${unviewed} to view` : "Helix",
        icon: "Code",
        run: () => {
          if (unviewed > 0) railTab.set("changes");
          navigate.toPluginPanel(EDITOR_PANEL, { subPath: thread.id });
        },
      };
    },
  });

  app.composer.customize({
    id: "helix",
    scopes: ["thread"],
    actions: [{ id: "position", component: PositionAction }],
    banners: [
      { id: "position", component: PositionChip, chrome: "bare" },
      { id: "from-helix", component: FromHelixReceipt, chrome: "bare" },
    ],
  });

  app.slots.experimental_appOverlay({ id: "helix", component: HelixOverlay });

  app.commands.register({
    id: "open-editor",
    title: "Helix: open the editor for this thread",
    defaultShortcut: { key: "e", alt: true, mod: true },
    isAvailable: ({ threadId }) => threadId !== null,
    run: ({ threadId }) => {
      if (threadId) commandRequest.set({ kind: "open", threadId, at: Date.now() });
    },
  });
  // The editor page's actions (also `:bb-emit <name>` in Helix). Option+Cmd
  // keys are free in bb (checked against its Keyboard settings).
  const onPage = () => [...pageActions.keys()][0] ?? null;
  const pageCommand = (id: string, title: string, action: string, shortcut?: { key: string; alt?: boolean; mod?: boolean; shift?: boolean }) =>
    app.commands.register({
      id,
      title,
      ...(shortcut ? { defaultShortcut: shortcut } : {}),
      isAvailable: () => onPage() !== null,
      run: () => {
        const threadId = onPage();
        if (threadId) pageActions.get(threadId)?.(action, []);
      },
    });
  pageCommand("next-file", "Helix: next changed file", "review.next-file", { key: "]", alt: true, mod: true });
  pageCommand("prev-file", "Helix: previous changed file", "review.prev-file", { key: "[", alt: true, mod: true });
  pageCommand("viewed", "Helix: mark this file viewed and go to the next", "review.viewed", { key: "v", alt: true, mod: true });
  pageCommand("send", "Helix: send review comments to the thread", "review.send", { key: "Enter", alt: true, mod: true });
  pageCommand("chat", "Helix: focus the chat", "chat.focus", { key: "c", alt: true, mod: true });
  pageCommand("rail-files", "Helix: show the files", "rail.files", { key: "1", alt: true, mod: true });
  pageCommand("rail-changes", "Helix: show the changes", "rail.changes", { key: "2", alt: true, mod: true });
  pageCommand("rail-comments", "Helix: show the comments", "rail.comments", { key: "3", alt: true, mod: true });

  app.commands.register({
    id: "focus-editor",
    title: "Helix: switch between the rail and the editor",
    defaultShortcut: { key: "h", mod: true, shift: true },
    isAvailable: () => visibleSurfaces.size > 0,
    run: () => {
      const controls = [...surfaceControls.values()][0];
      if (controls) controls.switchFocus();
      else void focusEditor();
    },
  });
  app.commands.register({
    id: "toggle-tree",
    title: "Helix: show or hide the files",
    defaultShortcut: { key: "y", mod: true, shift: true },
    isAvailable: () => surfaceControls.size > 0,
    run: () => [...surfaceControls.values()][0]?.toggleTree(),
  });
  app.commands.register({
    id: "review",
    title: "Helix: review changes",
    isAvailable: ({ threadId }) => threadId !== null,
    run: ({ threadId }) => {
      if (threadId) commandRequest.set({ kind: "review", threadId, at: Date.now() });
    },
  });
  app.commands.register({
    id: "bind",
    title: "Helix: bind this thread to a running Helix",
    isAvailable: ({ threadId }) => threadId !== null,
    run: ({ threadId }) => {
      if (threadId) commandRequest.set({ kind: "bind", threadId, at: Date.now() });
    },
  });
});
