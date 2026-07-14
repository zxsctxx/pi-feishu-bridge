export interface ClarifyTransport { sendCard(chatId: string, card: Record<string, unknown>, replyToMsgId?: string): Promise<string | null>; updateCard(messageId: string, card: Record<string, unknown>): Promise<void>; }
export interface ClarifyAction { clarifyId: string; choice: string; senderOpenId: string; }
interface Pending { id: string; messageId: string; allowedOpenIds: string[]; resolve: (choice: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; settled: boolean; }

export class ClarifyManager {
  private pending: Pending | null = null;
  private busy = false;
  constructor(private readonly transport: ClarifyTransport) {}
  get hasPending(): boolean { return this.busy; }

  async ask(chatId: string, question: string, choices: string[], allowedOpenIds: string[], timeoutMs: number, signal?: AbortSignal): Promise<string> {
    if (this.hasPending) throw new Error("已有一个等待中的飞书澄清请求");
    this.busy = true;
    const id = `clarify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const card = this.card(id, question, choices);
    let messageId: string | null;
    try { messageId = await this.transport.sendCard(chatId, card); }
    catch (error) { this.busy = false; throw error; }
    if (!messageId) { this.busy = false; throw new Error("澄清卡片发送失败"); }
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { void this.finish("timeout", new Error("飞书澄清请求超时")); }, timeoutMs);
      this.pending = { id, messageId, allowedOpenIds, resolve, reject, timer, settled: false };
      signal?.addEventListener("abort", () => { void this.finish("aborted", new Error("飞书澄清请求已取消")); }, { once: true });
    });
  }

  async handleAction(action: ClarifyAction): Promise<boolean> {
    const pending = this.pending;
    if (!pending || pending.settled || pending.id !== action.clarifyId) return false;
    if (pending.allowedOpenIds.length && !pending.allowedOpenIds.includes(action.senderOpenId)) return false;
    await this.finish("submitted", undefined, action.choice); return true;
  }
  async abort(): Promise<void> { if (this.pending) await this.finish("aborted", new Error("飞书澄清请求已取消")); }

  private async finish(status: "submitted" | "timeout" | "aborted", error?: Error, choice?: string): Promise<void> {
    const pending = this.pending; if (!pending || pending.settled) return; pending.settled = true; clearTimeout(pending.timer);
    await this.transport.updateCard(pending.messageId, { schema: "2.0", body: { elements: [{ tag: "markdown", content: status === "submitted" ? `✅ 已选择：**${choice}**` : status === "timeout" ? "⌛ 澄清请求已超时" : "已取消澄清请求" }] } }).catch(() => {});
    this.pending = null; this.busy = false; if (error) pending.reject(error); else pending.resolve(choice ?? "");
  }
  private card(id: string, question: string, choices: string[]): Record<string, unknown> {
    return { schema: "2.0", body: { elements: [{ tag: "markdown", content: question }, { tag: "action", actions: choices.map((choice) => ({ tag: "button", text: { tag: "plain_text", content: choice }, type: "primary", value: { clarify_id: id, choice } })) }] } };
  }
}
