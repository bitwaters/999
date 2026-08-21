export type EventLoopLagSnapshot = { lastLagMs: number; maxLagMs: number; incomplete: boolean };

export class EventLoopLagMonitor {
  private timer: NodeJS.Timeout | undefined;
  private lastLagMs = 0;
  private maxLagMs = 0;

  public constructor(
    private readonly sampleIntervalMs: number,
    private readonly incompleteThresholdMs: number,
  ) {}

  public start(): void {
    if (this.timer) return;
    let expected = performance.now() + this.sampleIntervalMs;
    this.timer = setInterval(() => {
      const now = performance.now();
      this.lastLagMs = Math.max(0, now - expected);
      this.maxLagMs = Math.max(this.maxLagMs, this.lastLagMs);
      expected = now + this.sampleIntervalMs;
    }, this.sampleIntervalMs);
    this.timer.unref();
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  public snapshot(): EventLoopLagSnapshot {
    return {
      lastLagMs: this.lastLagMs,
      maxLagMs: this.maxLagMs,
      incomplete: this.maxLagMs > this.incompleteThresholdMs,
    };
  }

  public record(lagMs: number): EventLoopLagSnapshot {
    this.lastLagMs = Math.max(0, lagMs);
    this.maxLagMs = Math.max(this.maxLagMs, this.lastLagMs);
    return this.snapshot();
  }

  public resetWindow(): void {
    this.lastLagMs = 0;
    this.maxLagMs = 0;
  }
}
