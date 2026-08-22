export type QueueTask = {
  weight: number;
  priority: number;
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

export class WeightedRequestQueue {
  private readonly queue: QueueTask[] = [];
  private running = false;
  private nextAllowedAt = 0;
  private blockedUntil = 0;

  public constructor(private readonly minimumIntervalMs: number) {}

  public enqueue<T>(
    run: () => Promise<T>,
    options: { weight: number; priority: number },
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        ...options,
        run: async () => run(),
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.queue.sort((a, b) => b.priority - a.priority || a.weight - b.weight);
      void this.drain();
    });
  }

  public blockUntil(timestampMs: number): void {
    this.blockedUntil = Math.max(this.blockedUntil, timestampMs);
  }

  private async drain(): Promise<void> {
    if (this.running || this.queue.length === 0) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const waitUntil = Math.max(this.nextAllowedAt, this.blockedUntil);
        const waitMs = waitUntil - Date.now();
        if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
        const task = this.queue.shift()!;
        this.nextAllowedAt = Date.now() + this.minimumIntervalMs;
        try {
          task.resolve(await task.run());
        } catch (error) {
          task.reject(error);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
