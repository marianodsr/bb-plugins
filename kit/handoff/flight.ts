// The handoff's signature motion, done imperatively on a fixed overlay so it
// never touches the caller's layout or blocks input (the layer has
// pointer-events: none). Three beats, about 520 ms in total:
//
//   1. lift and gather: ghosts of the selected items lift and fly into the
//      Send control while a packet forms there;
//   2. travel: the packet springs to the target (composer, thread row, or the
//      new-thread dialog) along a slight arc;
//   3. settle: the packet lands with a brief ring on the target, and the
//      source items return to full opacity.
//
// Every animation is tracked so `cancel()` can jump to the end state at any
// moment. Under reduced motion no flight runs; the caller cross-fades the
// status chip instead.
import { animate, type AnimationPlaybackControls } from "motion";
import { ms, spring } from "../motion";

const MAX_GHOSTS = 6;
const EASE_ENTER = [0.22, 1, 0.36, 1] as const;
const EASE_EXIT = [0.42, 0, 1, 1] as const;

export interface FlightPlan {
  sources: readonly HTMLElement[];
  origin: HTMLElement | null;
  /** Called when the packet sets off, so late-mounting targets can be found. */
  target: () => Element | null;
  label: string;
  /** Portal scope attributes so plugin utility classes apply in the layer. */
  scope: Record<string, string>;
}

export interface Flight {
  /** Resolves when the flight has finished or been cancelled. */
  finished: Promise<void>;
  /** Jump to the end state now. Safe to call more than once. */
  cancel(): void;
  /** The write failed: fly a packet from the target back to the origin. */
  returnHome(): Promise<void>;
}

const center = (r: DOMRect) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });

/** The part of a rect inside the viewport, or null when none of it is. */
function visiblePart(r: DOMRect): DOMRect | null {
  const left = Math.max(r.left, 0);
  const top = Math.max(r.top, 0);
  const right = Math.min(r.right, innerWidth);
  const bottom = Math.min(r.bottom, innerHeight);
  return right - left > 1 && bottom - top > 1 ? new DOMRect(left, top, right - left, bottom - top) : null;
}

const inViewport = (r: DOMRect) =>
  r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;

function makeLayer(scope: Record<string, string>) {
  const layer = document.createElement("div");
  layer.setAttribute("data-kit-handoff-layer", "");
  for (const [k, v] of Object.entries(scope)) layer.setAttribute(k, v);
  Object.assign(layer.style, {
    position: "fixed",
    inset: "0",
    pointerEvents: "none",
    zIndex: "2147483000",
    contain: "layout style",
  } satisfies Partial<CSSStyleDeclaration>);
  document.body.appendChild(layer);
  return layer;
}

function makePacket(layer: HTMLElement, label: string) {
  const packet = document.createElement("div");
  packet.className =
    "absolute left-0 top-0 flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full bg-foreground px-3 text-xs font-medium tabular-nums text-background shadow-lg";
  const dot = document.createElement("span");
  dot.className = "size-1.5 rounded-full bg-background/70";
  packet.append(dot, document.createTextNode(label));
  packet.style.opacity = "0";
  layer.appendChild(packet);
  return packet;
}

export function startFlight(plan: FlightPlan): Flight {
  const controls: AnimationPlaybackControls[] = [];
  const timers: number[] = [];
  const dimmed = new Map<HTMLElement, number>();
  let done = false;
  let resolveFinished!: () => void;
  const finished = new Promise<void>((r) => (resolveFinished = r));
  const layer = makeLayer(plan.scope);

  const track = (c: AnimationPlaybackControls) => {
    controls.push(c);
    return c;
  };
  const later = (delay: number, fn: () => void) => {
    timers.push(window.setTimeout(fn, delay));
  };
  const restoreSources = (fade: boolean) => {
    // Fade back to the opacity each element had before the lift. Not tracked,
    // so cancel() cannot snap it back to the dimmed value.
    dimmed.forEach((opacity, el) => {
      if (!el.isConnected) return;
      void animate(el, { opacity }, { duration: (fade ? ms.enter : ms.press) / 1000, ease: EASE_ENTER }).finished.then(
        () => el.style.removeProperty("opacity"),
      );
    });
    dimmed.clear();
  };
  const finish = () => {
    if (done) return;
    done = true;
    timers.forEach(clearTimeout);
    controls.forEach((c) => {
      if (c.state !== "finished") c.complete();
    });
    restoreSources(false);
    layer.remove();
    resolveFinished();
  };

  const originRect = plan.origin?.isConnected ? plan.origin.getBoundingClientRect() : null;
  const visible = plan.sources
    .filter((el) => el.isConnected)
    .map((el) => ({ el, rect: el.getBoundingClientRect() }))
    .filter(({ rect }) => inViewport(rect));
  const firstRect = visible[0]?.rect ?? null;
  const gatherRect = originRect ?? firstRect;
  if (!gatherRect) {
    // Nothing on screen to animate from; the status chip carries the result.
    finish();
    return { finished, cancel: finish, returnHome: async () => {} };
  }
  const gather = center(gatherRect);

  // Beat 1: lift and gather.
  visible.forEach(({ el }) => {
    dimmed.set(el, Number.parseFloat(getComputedStyle(el).opacity) || 1);
    // Not tracked: restoreSources() animates the same value, which supersedes it.
    void animate(el, { opacity: 0.4 }, { duration: ms.press / 1000, ease: "easeOut" });
  });
  visible.slice(0, MAX_GHOSTS).forEach(({ el, rect }, i) => {
    const ghost = document.createElement("div");
    ghost.className = "absolute overflow-hidden rounded-lg bg-card shadow-lg";
    Object.assign(ghost.style, {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      transformOrigin: "center",
    });
    const clone = el.cloneNode(true) as HTMLElement;
    clone.removeAttribute("id");
    clone.style.opacity = "1";
    clone.style.margin = "0";
    clone.setAttribute("aria-hidden", "true");
    ghost.appendChild(clone);
    layer.appendChild(ghost);
    const from = center(rect);
    const scale = Math.min(0.3, 120 / Math.max(rect.width, 1));
    track(
      animate(
        ghost,
        {
          x: [0, 0, gather.x - from.x],
          y: [0, -6, gather.y - from.y],
          scale: [1, 1.03, scale],
          opacity: [1, 1, 0],
        },
        { duration: 0.26, times: [0, 0.3, 1], ease: [EASE_ENTER, EASE_ENTER], delay: i * 0.025 },
      ),
    );
  });

  const packet = makePacket(layer, plan.label);
  const size = packet.getBoundingClientRect();
  const place = (p: { x: number; y: number }) => ({ x: p.x - size.width / 2, y: p.y - size.height / 2 });
  const start = place(gather);
  packet.style.left = `${start.x}px`;
  packet.style.top = `${start.y}px`;
  track(
    animate(
      packet,
      { opacity: [0, 1], scale: [0.6, 1] },
      { duration: ms.press / 1000, delay: 0.14, ease: EASE_ENTER },
    ),
  );

  // Beat 2: travel. The target is resolved after layout settles (two frames
  // past the gather), then followed during the flight: a composer grows as
  // the prompt lands in it, and a dialog may still be opening.
  const margin = 8;
  const clampPoint = (p: { x: number; y: number }) => ({
    x: Math.min(Math.max(p.x, size.width / 2 + margin), innerWidth - size.width / 2 - margin),
    y: Math.min(Math.max(p.y, size.height / 2 + margin), innerHeight - size.height / 2 - margin),
  });
  const resolve = () => {
    const el = plan.target();
    const r = el?.isConnected ? el.getBoundingClientRect() : null;
    const visible = r ? visiblePart(r) : null;
    return visible ? { rect: visible, point: place(clampPoint(center(visible))) } : null;
  };
  const frames = (n: number, fn: () => void) =>
    n === 0 ? fn() : requestAnimationFrame(() => frames(n - 1, fn));

  later(240, () =>
    frames(2, () => {
      if (done) return;
      let target = resolve();
      let dest = target?.point ?? start;
      const arcLift = Math.min(160, Math.abs(dest.x - start.x) * 0.25 + 40);
      track(animate(packet, { x: dest.x - start.x }, { ...spring.handoff }));
      track(animate(packet, { y: dest.y - start.y }, { ...spring.handoff, velocity: -arcLift * 6 }));

      // Follow the target while the packet is in the air.
      const follow = () => {
        if (done || landed) return;
        const next = resolve();
        if (next && (Math.abs(next.point.x - dest.x) > 4 || Math.abs(next.point.y - dest.y) > 4)) {
          target = next;
          dest = next.point;
          track(animate(packet, { x: dest.x - start.x, y: dest.y - start.y }, { ...spring.handoff }));
        }
        requestAnimationFrame(follow);
      };
      let landed = false;
      requestAnimationFrame(follow);

      // Beat 3: settle.
      later(210, () => {
        landed = true;
        if (done) return;
        const final = resolve() ?? target;
        track(animate(packet, { scale: 0.5, opacity: 0 }, { duration: 0.09, ease: EASE_EXIT }));
        if (final) {
          const ring = document.createElement("div");
          ring.className = "absolute rounded-xl ring-2 ring-ring/45";
          Object.assign(ring.style, {
            left: `${final.rect.left}px`,
            top: `${final.rect.top}px`,
            width: `${final.rect.width}px`,
            height: `${final.rect.height}px`,
            opacity: "0",
          });
          layer.appendChild(ring);
          track(animate(ring, { opacity: [0, 1, 0] }, { duration: 0.42, times: [0, 0.2, 1], ease: "easeOut" }));
        }
        restoreSources(true);
        later(440, finish);
      });
    }),
  );

  const returnHome = async () => {
    // Fly back from wherever the work was headed, then dissolve.
    finish();
    const back = makeLayer(plan.scope);
    const pkt = makePacket(back, plan.label);
    const s = pkt.getBoundingClientRect();
    const targetRect = plan.target()?.getBoundingClientRect();
    const visible = targetRect ? visiblePart(targetRect) : null;
    const from = visible ? center(visible) : gather;
    const at = (p: { x: number; y: number }) => ({ x: p.x - s.width / 2, y: p.y - s.height / 2 });
    const a = at(from);
    const b = at(gather);
    pkt.style.left = `${a.x}px`;
    pkt.style.top = `${a.y}px`;
    await animate(pkt, { opacity: [0, 1] }, { duration: 0.08 });
    await animate(pkt, { x: b.x - a.x, y: b.y - a.y }, { ...spring.handoff });
    await animate(pkt, { opacity: 0, scale: 0.8 }, { duration: ms.exit / 1000, ease: EASE_EXIT });
    back.remove();
  };

  return { finished, cancel: finish, returnHome };
}

/** Best-effort DOM targets in bb's own UI. Not a public contract; every use falls back. */
export const targets = {
  /** The visible prompt box; with several, the largest one in view. */
  composer(within?: ParentNode | null): Element | null {
    const boxes = Array.from((within ?? document).querySelectorAll("[data-promptbox-layout]"))
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => inViewport(r))
      .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height);
    return boxes[0]?.el ?? null;
  },
  /** A thread's sidebar row: `data-sidebar-thread-id` is bb's documented row contract. */
  sidebarRow(threadId: string): Element | null {
    const row = document.querySelector(`[data-sidebar-thread-id="${CSS.escape(threadId)}"]`);
    return row && inViewport(row.getBoundingClientRect()) ? row : null;
  },
};
