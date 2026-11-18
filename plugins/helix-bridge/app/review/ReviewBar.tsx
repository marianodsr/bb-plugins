// The quiet bar above Helix while a review is active or comments wait to be
// sent. Each thing is said once: with the rail's Changes tab on screen the bar
// carries only what the rail does not (the pull request, the inline diff
// switch, Send to thread); otherwise it also names the review and how much of
// it is viewed. Clicking the review's name shows the Changes tab.
import { useMemo, useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { useHelixRpc } from "../data";
import { useChanges } from "../rail/changesStore";
import { useComments } from "../rail/commentsStore";
import { railFocus, railSheet, railTab, useRailShown, useRailTab } from "../rail/railStore";
import { SendToThread, useRecentSend } from "./SendToThread";

export function ReviewBar({ threadId }: { threadId: string }) {
  const rpc = useHelixRpc();
  const navigate = useBbNavigate();
  const { data, refetch } = useChanges(threadId);
  const comments = useComments(threadId).data;
  const tab = useRailTab();
  const railShown = useRailShown(threadId);
  const review = data?.review ?? null;
  const [inline, setInline] = useState<boolean | null>(null);
  const files = review?.files;
  const viewed = useMemo(() => files?.filter((f) => f.viewed).length ?? 0, [files]);
  const unsent = comments?.unsent ?? 0;
  const recentSend = useRecentSend(threadId);
  if (!review && unsent === 0 && !recentSend) return null;
  // The rail says it already.
  const summaryInRail = railShown && tab === "changes";
  const diffOn = inline ?? review?.inline ?? true;
  const showChanges = () => {
    railTab.set("changes");
    railSheet.set(threadId);
    window.setTimeout(() => railFocus.get(threadId)?.(), 0);
  };
  return (
    <div className="flex h-8 shrink-0 items-center gap-3 border-b border-border/60 bg-background px-3 text-xs" data-helix-review-bar>
      {review && !summaryInRail ? (
        <>
          <button
            type="button"
            onClick={showChanges}
            title="Show the changes"
            className="flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Icon name="GitCompare" className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate">{review.title}</span>
          </button>
          <span className="shrink-0 tabular-nums text-muted-foreground" data-helix-bar-viewed>
            {review.files.length === 0 ? "No changes" : viewed === review.files.length ? "All viewed" : `${viewed} of ${review.files.length} viewed`}
          </span>
          <span className="hidden shrink-0 tabular-nums sm:inline">
            <span className="text-diff-added">+{review.additions}</span> <span className="text-diff-removed">-{review.deletions}</span>
          </span>
        </>
      ) : null}
      {data?.pullRequest ? (
        <button
          type="button"
          onClick={() => data.pullRequest?.url && navigate.openUrl(data.pullRequest.url)}
          disabled={!data.pullRequest.url}
          title={data.pullRequest.url ? "Open the pull request" : undefined}
          className="inline-flex shrink-0 items-center gap-1 rounded-md px-1 py-0.5 tabular-nums text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Icon name="GitPullRequest" className="size-3.5" />#{data.pullRequest.number}
        </button>
      ) : null}
      <span className="ml-auto flex shrink-0 items-center gap-2">
        {review ? (
          <button
            type="button"
            aria-pressed={diffOn}
            title="Show the diff inline in Helix"
            onClick={() => {
              const next = !diffOn;
              setInline(next);
              void rpc.call("setInline", { threadId, inline: next }).then(refetch, () => setInline(null));
            }}
            className={cn(
              "h-6 rounded-md px-2 transition-colors duration-[120ms] hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              diffOn ? "bg-muted text-foreground" : "text-muted-foreground",
            )}
          >
            Diff
          </button>
        ) : null}
        <SendToThread threadId={threadId} />
        {review ? (
          <button
            type="button"
            aria-label="End review"
            title="End review"
            onClick={() => void rpc.call("startReview", { threadId, target: "off" }).then(refetch, refetch)}
            className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors duration-[120ms] hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Icon name="X" className="size-3.5" />
          </button>
        ) : null}
      </span>
    </div>
  );
}
