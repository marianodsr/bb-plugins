// Kit Gallery: a dev-only page that renders every piece of the shared kit
// (/kit, copied into ./kit by kit/scripts/sync.mjs) in its states, plus a live
// handoff demo. The same body also mounts as a thread side-panel tab so the
// kit can be judged at 420 px and against a real composer.
import { useRef } from "react";
import {
  definePluginApp,
  experimental_useSidebarThreads as useSidebarThreads,
  useBbContext,
} from "@get-bb/plugin-sdk/app";
import { ShortcutSheet } from "./kit";
import { HandoffDemo } from "./gallery/HandoffDemo";
import { Keys, LoadingAndEmpty, MotionTokens, Section, Status, Tints, TypeRoles } from "./gallery/Pieces";

function Gallery({ threadId }: { threadId: string | null }) {
  const context = useBbContext();
  const { threads } = useSidebarThreads();
  const liveThread = threads.find((t) => !t.isHidden) ?? null;
  const page = useRef<HTMLDivElement>(null);
  const currentThreadId = threadId ?? context.threadId ?? null;
  const projectId = context.projectId ?? liveThread?.projectId ?? null;

  return (
    <div ref={page} data-gallery-scroll="" className="@container h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col px-4 pb-16 @[40rem]:px-5">
        <div className="flex items-center justify-between gap-3 pt-4 pb-2">
          <p className="text-xs text-muted-foreground">
            Dev only. Every kit piece in its states; press <span className="font-medium text-foreground">?</span> for shortcuts.
          </p>
          <ShortcutSheet />
        </div>
        <Section
          id="handoff"
          title="Handoff"
          description="Select items, then Send to thread (S). Targets: this thread (insert or send now), another thread, or a new thread. Fake threads and destinations by default."
        >
          <HandoffDemo currentThreadId={currentThreadId} projectId={projectId} />
        </Section>
        <Section id="type" title="Type roles" description="Host UI and code fonts; character from the scale.">
          <TypeRoles />
        </Section>
        <Section id="motion" title="Motion tokens" description="Each demo uses its token. Reduced motion keeps only 120 ms fades.">
          <MotionTokens />
        </Section>
        <Section id="keys" title="Segmented, keys and shortcuts">
          <Keys />
        </Section>
        <Section id="status" title="Status and thread chips">
          <Status liveThreadId={currentThreadId ?? liveThread?.id ?? null} />
        </Section>
        <Section id="tint" title="Tints" description="Tailwind palette at 15% with same-hue text, switched by bb's .dark class.">
          <Tints />
        </Section>
        <Section id="loading" title="Loading, collapse, empty and inline create">
          <LoadingAndEmpty />
        </Section>
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "gallery",
    title: "Kit Gallery",
    icon: "Palette",
    path: "gallery",
    component: () => <Gallery threadId={null} />,
  });
  app.slots.experimental_tab({
    context: { kind: "thread" },
    availability: "action",
    id: "kit",
    title: "Kit Gallery",
    icon: "Palette",
    layout: "flush",
    component: ({ threadId }) => <Gallery threadId={threadId} />,
  });
});
