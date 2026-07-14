export class FlushScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private currentFlush: Promise<void> | null = null;
  private needsReflush = false;
  private completed = false;
  private lastFlushAt = 0;

  constructor(private readonly intervalMs: number) {}

  schedule(flush: () => Promise<void>): void {
    if (this.completed) return;
    if (this.currentFlush) {
      this.needsReflush = true;
      return;
    }
    if (this.timer) return;
    const delay = Math.max(0, this.intervalMs - (Date.now() - this.lastFlushAt));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.start(flush);
    }, delay);
  }

  async flushNow(flush: () => Promise<void>): Promise<void> {
    if (this.completed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.currentFlush) await this.currentFlush;
    if (!this.completed) await this.start(flush);
  }

  complete(): void {
    this.completed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private start(flush: () => Promise<void>): Promise<void> {
    if (this.currentFlush) {
      this.needsReflush = true;
      return this.currentFlush;
    }
    const promise = this.run(flush);
    this.currentFlush = promise;
    promise.finally(() => {
      if (this.currentFlush === promise) this.currentFlush = null;
    }).catch(() => {});
    return promise;
  }

  private async run(flush: () => Promise<void>): Promise<void> {
    this.needsReflush = false;
    try {
      await flush();
    } catch {
      // Card manager owns fallback behavior.
    } finally {
      this.lastFlushAt = Date.now();
    }
    if (this.needsReflush && !this.completed) {
      this.needsReflush = false;
      await this.run(flush);
    }
  }
}
