// The Issue tab on threads that an issue was sent to: the issue as a
// document beside the chat. Shown only for linked threads.
import { useBbContext, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useEffect, useState } from "react";
import { Segmented } from "../kit";
import { IssueDocument, DocumentSkeleton } from "./IssueDocument";
import { formatSubPath } from "./logic";
import { PANEL_PATH, useStatus, useThreadIssues } from "./rpc";
import { SetupState } from "./SetupState";

export function useThreadHasIssues({ threadId }: { threadId: string }): boolean {
  const linked = useThreadIssues(threadId);
  return (linked.data?.keys.length ?? 0) > 0;
}

export function ThreadIssueTab({ threadId }: { threadId: string }) {
  const navigate = useBbNavigate();
  const { projectId } = useBbContext();
  const status = useStatus();
  const linked = useThreadIssues(threadId);
  const keys = linked.data?.keys ?? [];
  const [current, setCurrent] = useState<string | null>(null);
  useEffect(() => {
    if (current === null || !keys.includes(current)) setCurrent(keys[keys.length - 1] ?? null);
  }, [keys, current]);

  if (status.data && !status.data.configured) return <SetupState status={status.data} />;
  if (!current) return <DocumentSkeleton />;
  return (
    <div className="flex h-full min-h-0 flex-col">
      {keys.length > 1 ? (
        <div className="shrink-0 px-4 pt-3">
          <Segmented
            aria-label="Linked issues"
            value={current}
            onChange={setCurrent}
            options={keys.map((key) => ({ value: key, label: key }))}
          />
        </div>
      ) : null}
      <IssueDocument
        key={current}
        issueKey={current}
        currentThreadId={threadId}
        projectId={projectId}
        hotkeysEnabled={false}
        onOpenIssue={(key) => navigate.toPluginPanel(PANEL_PATH, { subPath: formatSubPath(null, key) })}
      />
    </div>
  );
}
