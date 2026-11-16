import type { MouseEvent } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { cn } from "../lib/utils";
import type { ExternalRef } from "../src/schemas";
import { useIntegrations } from "./data";

/** Route Jira Viewer owns for one issue (cross-plugin contract). */
export function jiraViewerPath(key: string): string {
  return `/plugins/jira-viewer/issues/${encodeURIComponent(key)}`;
}

/**
 * Open an app route that belongs to another plugin. Plugin navigation only
 * reaches this plugin's own panels, so push the route and let the app's
 * router pick it up; a modified click keeps the browser's own behaviour.
 */
export function openAppRoute(path: string): void {
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
}

/**
 * A task's Jira issue. Opens it in Jira Viewer when that plugin runs,
 * otherwise in Jira.
 */
export function JiraChip({ externalRef, compact }: { externalRef: ExternalRef; compact?: boolean }) {
  const integrations = useIntegrations();
  const navigate = useBbNavigate();
  const inViewer = integrations.data?.jiraViewer === true;
  const href = inViewer ? jiraViewerPath(externalRef.key) : externalRef.url;

  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    event.stopPropagation();
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    if (inViewer) openAppRoute(href);
    else navigate.openUrl(externalRef.url);
  };

  return (
    <a
      href={href}
      onClick={open}
      onPointerDown={(event) => event.stopPropagation()}
      title={inViewer ? `Open ${externalRef.key} in Jira Viewer` : `Open ${externalRef.key} in Jira`}
      className={cn(
        "inline-flex items-center rounded-md border border-border/70 bg-background px-1.5 text-xs font-medium tabular-nums text-foreground",
        "no-underline transition-colors duration-[120ms] ease-out hover:bg-state-hover",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        compact ? "h-5" : "h-6",
      )}
    >
      {externalRef.key}
    </a>
  );
}
