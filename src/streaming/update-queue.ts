export class UpdateQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;

  enqueue(operation: () => Promise<void>): Promise<void> {
    this.pending++;
    const result = this.tail.then(operation, operation);
    this.tail = result.catch(() => {}).finally(() => { this.pending--; });
    return result;
  }

  async drain(): Promise<void> { await this.tail; }
  get size(): number { return this.pending; }
}
