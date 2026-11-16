// Review Editor frontend: the file editor (a fileOpener), the thread Review
// tab, and palette commands. The backend contract is in server/contract.ts.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import "./app/editor/editor.css";
import { FileOpener } from "./app/components/FileOpener";
import { ReviewTab, useReviewTabVisible } from "./app/components/ReviewTab";
import { OPENER_EXTENSIONS } from "./app/model/languages";

export const OPENER_ID = "editor";

export default definePluginApp((app) => {
  app.slots.fileOpener({
    id: OPENER_ID,
    title: "Review Editor",
    extensions: OPENER_EXTENSIONS,
    component: FileOpener,
  });

  app.slots.experimental_tab({
    context: { kind: "thread" },
    availability: "fixed",
    id: "review",
    title: "Review",
    icon: "MessageSquare",
    tooltip: "Changed files and review comments",
    layout: "flush",
    component: ReviewTab,
    useVisible: useReviewTabVisible,
  });

  app.commands.register({
    id: "show-review",
    title: "Review Editor: show changes and comments",
    isAvailable: (context) => context.threadId !== null,
    run: (context) => {
      context.experimental_panel.openTab({ tab: { id: "review", context: { kind: "thread" }, availability: "fixed" } });
    },
  });
});
