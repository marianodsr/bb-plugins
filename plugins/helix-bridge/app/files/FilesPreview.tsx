// The file tree on a workspace that lives in memory, at the rail's width, with
// no Helix and no thread behind it: `/plugins/helix-bridge/editor/~files`.
// Its operations really change that workspace (until the page reloads), and
// every call waits a little, so loading can be seen. It is how the tree's look
// is checked in light and dark (kit/scripts/shoot.mjs) and its speed measured
// (`window.__filesTimeline`); nothing links to it.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { railMemory } from "../rail/railMemory";
import { FileTree, type FileTreeHandle } from "./FileTree";
import { memoryLink, type MemoryLink } from "./memoryLink";
import { demoWorkspace, memorySource, type MemorySource } from "./memorySource";

export const FILES_PREVIEW_PATH = "~files";
const THREAD = "~files-preview";

let source: MemorySource | null = null;
let link: MemoryLink | null = null;
const CHANGES = [
  { path: "services/auth/session.go", status: "modified" as const, viewed: false },
  { path: "services/auth/token.go", status: "modified" as const, viewed: true },
  { path: "services/auth/middleware.go", status: "added" as const, viewed: false },
  { path: "services/gateway/router.go", status: "modified" as const, viewed: false },
  { path: "docs/sessions.md", status: "modified" as const, viewed: false },
];
const COMMENTS = [
  { path: "services/auth/session.go", state: "unsent" as const },
  { path: "services/auth/session.go", state: "answered" as const },
  { path: "services/gateway/router.go", state: "sent" as const },
  { path: "docs/sessions.md", state: "done" as const },
];
/** A turn of the fake agent: it splits the session errors, a few files at a time. */
const TURN = [
  [{ path: "services/auth/session.go", change: "edited" as const }],
  [{ path: "services/auth/errors.go", change: "created" as const }],
  [{ path: "services/auth/session_test.go", change: "edited" as const }, { path: "services/gateway/router.go", change: "edited" as const }],
  [{ path: "docs/sessions.md", change: "edited" as const }],
];
/** The fake agent works in turns: about 8 s of work, then 10 s of quiet, again and again. */
function startTurns(l: MemoryLink) {
  const loop = () => void l.turn(TURN, 1600).then(() => window.setTimeout(loop, 10_000));
  window.setTimeout(loop, 600);
}

declare global {
  interface Window {
    __filesTimeline?: { opened: number; firstFrame: number | null }[];
    /** For app/files/measure.mjs: put the cursor on a path. */
    __filesReveal?: (path: string) => void;
  }
}

export function FilesPreview() {
  source ??= memorySource(demoWorkspace(), { latency: 45 });
  if (!link) {
    link = memoryLink(source, { writeMs: 2500 });
    startTurns(link);
  }
  const memory = railMemory(THREAD).files;
  if (memory.cursor === null && memory.open.size === 0) {
    memory.open = new Set(["services", "services/auth"]);
    memory.cursor = "services/auth/session.go";
  }
  const [shown, setShown] = useState(true);
  const handle = useRef<FileTreeHandle | null>(null);
  const opened = useRef(performance.now());
  useEffect(() => {
    window.__filesReveal = (path) => handle.current?.reveal(path);
    return () => void delete window.__filesReveal;
  }, []);

  return (
    <div
      className="flex min-h-0 flex-1 justify-center bg-muted/40 p-6"
      onKeyDown={(event) => {
        // The rail is closed: e opens it again, as space e does from Helix.
        if (!shown && event.key === "e") {
          opened.current = performance.now();
          setShown(true);
        }
      }}
      tabIndex={-1}
      data-files-preview-page
    >
      <div className="flex h-[min(46rem,100%)] w-[22rem] flex-col border-r border-border/60 bg-background pt-3 shadow-lg" data-files-preview>
        {shown ? (
          <>
            <FileTree
              source={source}
              threadId={THREAD}
              link={link}
              changes={CHANGES}
              comments={COMMENTS}
              root="/Users/you/src/monorepo"
              handle={handle}
              onLeave={() => {
                setShown(false);
                window.setTimeout(() => document.querySelector<HTMLElement>("[data-files-preview-page]")?.focus(), 0);
              }}
            />
            <FirstFrame since={opened.current} />
          </>
        ) : (
          <p className="m-auto max-w-56 text-center text-sm text-muted-foreground">The rail is closed. Press E to open it again where it was.</p>
        )}
      </div>
    </div>
  );
}

/** Mounted after the tree: notes when the frame that shows it was painted. */
function FirstFrame({ since }: { since: number }) {
  useLayoutEffect(() => {
    const entry = { opened: since, firstFrame: null as number | null };
    (window.__filesTimeline ??= []).push(entry);
    document.querySelector<HTMLElement>("[data-files-list]")?.focus({ preventScroll: true });
    requestAnimationFrame(() => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => (entry.firstFrame = performance.now() - since);
      channel.port2.postMessage(null);
    });
  }, [since]);
  return null;
}
