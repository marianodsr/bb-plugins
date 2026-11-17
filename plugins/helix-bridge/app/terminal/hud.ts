// Measurements for the performance and key HUD: key-to-paint over the last
// keys, paint work per redraw, dropped frames, and the last key as received
// and as sent. Cheap enough to run whenever the HUD is on; off otherwise.

const WINDOW = 120;

export interface HudSnapshot {
  keyToPaint: { p50: number | null; p95: number | null; samples: number };
  redraw: { p50: number | null; p95: number | null };
  droppedFrames: number;
  frames: number;
  lastKey: string | null;
  lastSent: string | null;
}

function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]! * 10) / 10;
}

export class HudMeter {
  private pendingKey: number | null = null;
  private awaitingPaint = false;
  private outputAt = 0;
  private readonly keyToPaint: number[] = [];
  private readonly redraws: number[] = [];
  private lastFrame = 0;
  private frameIntervals: number[] = [];
  private dropped = 0;
  private frames = 0;
  lastKey: string | null = null;
  lastSent: string | null = null;

  key(description: string): void {
    this.lastKey = description;
    this.pendingKey = performance.now();
  }

  sent(text: string): void {
    this.lastSent = text;
  }

  /** Output arrived; measure to the frame that paints it. */
  output(): void {
    if (this.awaitingPaint) return;
    this.awaitingPaint = true;
    this.outputAt = performance.now();
    requestAnimationFrame((frameStart) => {
      // Queued after the renderer's own frame callback: the time since the
      // frame began is the renderer's paint work in it.
      const now = performance.now();
      this.awaitingPaint = false;
      this.redraws.push(now - frameStart);
      if (this.redraws.length > WINDOW) this.redraws.shift();
      if (this.pendingKey !== null && this.pendingKey <= this.outputAt) {
        this.keyToPaint.push(now - this.pendingKey);
        if (this.keyToPaint.length > WINDOW) this.keyToPaint.shift();
        this.pendingKey = null;
      }
      this.frame(frameStart);
    });
  }

  private frame(at: number): void {
    this.frames += 1;
    if (this.lastFrame > 0) {
      const interval = at - this.lastFrame;
      if (interval < 250) {
        this.frameIntervals.push(interval);
        if (this.frameIntervals.length > WINDOW) this.frameIntervals.shift();
        const typical = percentile(this.frameIntervals, 0.5) ?? 16.7;
        if (interval > typical * 1.5) this.dropped += Math.round(interval / typical) - 1;
      }
    }
    this.lastFrame = at;
  }

  snapshot(): HudSnapshot {
    return {
      keyToPaint: { p50: percentile(this.keyToPaint, 0.5), p95: percentile(this.keyToPaint, 0.95), samples: this.keyToPaint.length },
      redraw: { p50: percentile(this.redraws, 0.5), p95: percentile(this.redraws, 0.95) },
      droppedFrames: this.dropped,
      frames: this.frames,
      lastKey: this.lastKey,
      lastSent: this.lastSent,
    };
  }
}
