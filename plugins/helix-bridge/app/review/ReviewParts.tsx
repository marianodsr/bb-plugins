// Reviewing changes in Helix from bb: the editor page's control and the
// palette command open the same dialog, which starts a review (a target),
// shows the active one (title, files, open comments) and sends its comments.
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { EmptyState } from "../../kit";
import { useHelixRpc, useRead } from "../data";

const TARGETS: { target: string; label: string; detail: string }[] = [
  { target: "uncommitted", label: "Uncommitted changes", detail: "The working tree against HEAD" },
  { target: "branch", label: "This branch", detail: "Everything since it forked from the base branch" },
  { target: "pr", label: "The pull request", detail: "Against the pull request's base branch" },
  { target: "turn", label: "The last agent turn", detail: "What the agent's last turn changed" },
];

export function useReviewState(threadId: string | null) {
  return useRead((rpc) => (threadId ? rpc.call("reviewState", { threadId }) : Promise.resolve({ capable: false, review: null, openComments: 0 })), [threadId], ["review", "instances"]);
}

/** The editor page's header control: the active review at a glance, or "Review". */
export function ReviewControl({ threadId }: { threadId: string }) {
  const { data } = useReviewState(threadId);
  const [open, setOpen] = useState(false);
  if (!data?.capable) return null;
  const review = data.review;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "inline-flex h-7 max-w-64 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs transition-colors duration-[120ms] ease-out hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          review ? "text-foreground" : "text-muted-foreground",
        )}
        data-helix-review-control
      >
        <Icon name="GitCompare" className="size-3.5 shrink-0" />
        {review ? (
          <>
            <span className="truncate">{review.title}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">{review.files} files</span>
          </>
        ) : (
          <span>Review</span>
        )}
      </button>
      <ReviewDialog threadId={threadId} open={open} onOpenChange={setOpen} />
    </>
  );
}

export function ReviewDialog({ threadId, open, onOpenChange }: { threadId: string; open: boolean; onOpenChange(open: boolean): void }) {
  const rpc = useHelixRpc();
  const { data, refetch } = useReviewState(threadId);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [commit, setCommit] = useState("");
  const review = data?.review ?? null;

  const run = (key: string, work: () => Promise<{ message: string }>, close = false) => {
    setBusy(key);
    setMessage(null);
    work().then(
      ({ message: text }) => {
        setBusy(null);
        setMessage(text);
        refetch();
        if (close && !/^bb:|no |cannot|unknown/iu.test(text)) onOpenChange(false);
      },
      (cause: unknown) => {
        setBusy(null);
        setMessage(cause instanceof Error ? cause.message : String(cause));
      },
    );
  };
  const start = (target: string) => run(target, () => rpc.call("startReview", { threadId, target }), true);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-helix-review-dialog>
        <DialogHeader>
          <DialogTitle>Review in Helix</DialogTitle>
          <DialogDescription>Helix compares the files with the base you choose, draws the diff inline, and lists the files in :bb-review; :bb-next walks every change.</DialogDescription>
        </DialogHeader>
        {!data?.capable ? (
          <EmptyState icon="GitCompare" title="This Helix cannot review yet" description="Reviews need a newer Helix Bridge build, or open Helix for this thread first." />
        ) : (
          <div className="flex flex-col gap-4">
            {review ? (
              <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-card px-3 py-2.5" data-helix-review-active>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate text-sm font-medium">{review.title}</span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {review.files} files, +{review.additions} -{review.deletions}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">{data.openComments === 0 ? "No open comments" : `${data.openComments} open comment${data.openComments === 1 ? "" : "s"}`}</span>
                  <span className="ml-auto flex gap-2">
                    {data.openComments > 0 ? (
                      <Button size="sm" disabled={busy !== null} onClick={() => run("send", () => rpc.call("sendReviewComments", { threadId }))}>
                        Send comments
                      </Button>
                    ) : null}
                    <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => run("off", () => rpc.call("startReview", { threadId, target: "off" }))}>
                      End review
                    </Button>
                  </span>
                </div>
              </div>
            ) : null}
            <ul className="flex flex-col gap-1">
              {TARGETS.map((t) => (
                <li key={t.target}>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => start(t.target)}
                    className="flex min-h-11 w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                    data-helix-review-target={t.target}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm">{t.label}</span>
                      <span className="block text-xs text-muted-foreground">{t.detail}</span>
                    </span>
                    {busy === t.target ? <span className="text-xs text-muted-foreground">Starting</span> : review?.target === t.target ? <Icon name="Check" className="size-4 text-muted-foreground" /> : null}
                  </button>
                </li>
              ))}
            </ul>
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (commit.trim()) start(`commit ${commit.trim()}`);
              }}
            >
              <input
                value={commit}
                onChange={(event) => setCommit(event.target.value)}
                placeholder="A commit: sha, HEAD~2, a tag"
                aria-label="Review a commit"
                className="h-8 min-w-0 flex-1 rounded-md border border-border/60 bg-transparent px-2 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <Button size="sm" variant="outline" type="submit" disabled={busy !== null || !commit.trim()}>
                Review commit
              </Button>
            </form>
            {message ? (
              <p className="text-xs leading-5 text-muted-foreground" role="status">
                {message}
              </p>
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
