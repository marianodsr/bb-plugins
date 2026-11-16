// Jira Viewer frontend: the Issues page with its saved-views sidebar, and
// the Issue tab on threads an issue was sent to.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { IssuesPage } from "./ui/IssuesPage";
import { PANEL_ID, PANEL_PATH } from "./ui/rpc";
import { ThreadIssueTab, useThreadHasIssues } from "./ui/ThreadIssueTab";
import { ViewsSidebar } from "./ui/ViewsSidebar";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: PANEL_ID,
    title: "Jira",
    icon: "LayoutList",
    path: PANEL_PATH,
    component: IssuesPage,
    experimental_sidebar: ViewsSidebar,
  });
  app.slots.experimental_tab({
    context: { kind: "thread" },
    availability: "fixed",
    id: "issue",
    title: "Issue",
    icon: "FileText",
    layout: "flush",
    useVisible: useThreadHasIssues,
    component: ThreadIssueTab,
  });
});
