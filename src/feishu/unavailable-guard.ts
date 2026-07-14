export class UnavailableMessageGuard {
  private readonly entries = new Map<string, number>();
  constructor(private readonly ttlMs = 30 * 60 * 1000, private readonly now = () => Date.now()) {}

  mark(messageId: string): void { this.entries.set(messageId, this.now() + this.ttlMs); }
  has(messageId: string): boolean {
    const expires = this.entries.get(messageId);
    if (!expires) return false;
    if (expires <= this.now()) { this.entries.delete(messageId); return false; }
    return true;
  }
}
