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
import { FromHelixReceipt, PositionChip } from "./app/composer/ComposerParts";
import { HelixOverlay } from "./app/overlay/HelixOverlay";
import { commandRequest } from "./app/stores";
import { ChatTab, EDITOR_PANEL, EditorHeader, EditorPage } from "./app/pages/EditorPage";
import { visibleSurfaces } from "./app/surface/EditorSurface";
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
    item: ({ thread, navigate }) => ({ label: "Helix", icon: "Code", run: () => navigate.toPluginPanel(EDITOR_PANEL, { subPath: thread.id }) }),
  });

  app.composer.customize({
    id: "helix",
    scopes: ["thread"],
    banners: [
      { id: "position", component: PositionChip, chrome: "bare" },
      { id: "from-helix", component: FromHelixReceipt, chrome: "bare" },
    ],
  });

  app.slots.experimental_appOverlay({ id: "helix", component: HelixOverlay });

  app.commands.register({
    id: "open-editor",
    title: "Helix: open the editor for this thread",
    isAvailable: ({ threadId }) => threadId !== null,
    run: ({ threadId }) => {
      if (threadId) commandRequest.set({ kind: "open", threadId, at: Date.now() });
    },
  });
  app.commands.register({
    id: "reload",
    title: "Helix: reload buffers changed on disk",
    isAvailable: ({ threadId }) => threadId !== null,
    run: ({ threadId }) => {
      if (threadId) commandRequest.set({ kind: "reload", threadId, at: Date.now() });
    },
  });
  app.commands.register({
    id: "focus-editor",
    title: "Helix: focus the editor",
    defaultShortcut: { key: "h", mod: true, shift: true },
    isAvailable: () => visibleSurfaces.size > 0,
    run: () => void focusEditor(),
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
