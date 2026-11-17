// The quiet bar above Helix while a review is active: what is being reviewed,
// in words, how much is left, its size, the inline diff switch, and the way
// out. Clicking the title shows the rail's Changes tab.
import { useMemo, useState } from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { useHelixRpc } from "../data";
import { useChanges } from "../rail/changesStore";
import { railFocus, railTab } from "../rail/railStore";

export function ReviewBar({ threadId }: { threadId: string }) {
  const rpc = useHelixRpc();
  const { data, refetch } = useChanges(threadId);
  const review = data?.review ?? null;
  const [inline, setInline] = useState<boolean | null>(null);
  const files = review?.files;
  const viewed = useMemo(() => files?.filter((f) => f.viewed).length ?? 0, [files]);
  if (!review) return null;
  const diffOn = inline ?? review.inline ?? true;
  return (
    <div className="flex h-8 shrink-0 items-center gap-3 border-b border-border/60 bg-background px-3 text-xs" data-helix-review-bar>
      <button
        type="button"
        onClick={() => {
          railTab.set("changes");
          window.setTimeout(() => railFocus.get(threadId)?.(), 0);
        }}
        title="Show the changes"
        className="flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Icon name="GitCompare" className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate">{review.title}</span>
      </button>
      <span className="shrink-0 tabular-nums text-muted-foreground" data-helix-bar-viewed>
        {review.files.length === 0 ? "No changes" : viewed === review.files.length ? "All viewed" : `${viewed} of ${review.files.length} viewed`}
      </span>
      <span className="hidden shrink-0 tabular-nums @[28rem]:inline sm:inline">
        <span className="text-diff-added">+{review.additions}</span> <span className="text-diff-removed">-{review.deletions}</span>
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1">
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
        <button
          type="button"
          aria-label="End review"
          title="End review"
          onClick={() => void rpc.call("startReview", { threadId, target: "off" }).then(refetch, refetch)}
          className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors duration-[120ms] hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Icon name="X" className="size-3.5" />
        </button>
      </span>
    </div>
  );
}
