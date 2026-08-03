import { warn } from "../log.js";

export interface ClarifyTransport {
  createCard(card: Record<string, unknown>): Promise<string>;
  sendCardReference(chatId: string, cardId: string): Promise<string>;
  batchUpdate(cardId: string, actions: unknown[], sequence: number): Promise<void>;
}
export interface ClarifyOption { value: string; label: string; description?: string; }
export interface ClarifyAction { clarifyId: string; choice: string; senderOpenId: string; }
interface Pending { id: string; cardId: string; messageId: string; options: ClarifyOption[]; allowedOpenIds: string[]; resolve: (choice: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; settled: boolean; }

/** 卡片问题元素 id（batchUpdate 定位更新目标） */
const QUESTION_ELEMENT_ID = "question";
/** 下拉选择器元素 id（收尾时删除） */
const SELECT_ELEMENT_ID = "select";

export class ClarifyManager {
  private pending: Pending | null = null;
  private busy = false;
  private sequence = 0;
  constructor(private readonly transport: ClarifyTransport) {}
  get hasPending(): boolean { return this.busy; }

  async ask(chatId: string, question: string, options: ClarifyOption[], allowedOpenIds: string[], timeoutMs: number, signal?: AbortSignal): Promise<string> {
    if (this.hasPending) throw new Error("已有一个等待中的飞书澄清请求");
    // 信号在发送前已取消：不占位、不建卡
    if (signal?.aborted) throw new Error("飞书澄清请求已取消");
    this.busy = true;
    // 每张澄清卡是独立的新卡片，sequence 从 0 重新计数（本卡首增后为 1），
    // 避免跨卡共享实例级计数导致后续卡的 sequence 错位。澄清卡不共享 CardSession，无法走 session.nextSequence()
    this.sequence = 0;
    const id = `clarify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const card = this.card(id, question, options);
    let cardId: string;
    let messageId: string;
    try {
      cardId = await this.transport.createCard(card);
      messageId = await this.transport.sendCardReference(chatId, cardId);
    } catch (error) {
      this.busy = false;
      throw error;
    }
    if (!messageId) { this.busy = false; throw new Error("澄清卡片发送失败"); }
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { void this.finish("timeout", new Error("飞书澄清请求超时")); }, timeoutMs);
      this.pending = { id, cardId, messageId, options, allowedOpenIds, resolve, reject, timer, settled: false };
      // 发送期间信号可能已被取消：此时立即按取消收尾（更新卡片摘要 + 释放 busy），而非进入等待态
      if (signal?.aborted) { void this.finish("aborted", new Error("飞书澄清请求已取消")); return; }
      signal?.addEventListener("abort", () => { void this.finish("aborted", new Error("飞书澄清请求已取消")); }, { once: true });
    });
  }

  async handleAction(action: ClarifyAction): Promise<boolean> {
    const pending = this.pending;
    if (!pending || pending.settled || pending.id !== action.clarifyId) return false;
    if (pending.allowedOpenIds.length && !pending.allowedOpenIds.includes(action.senderOpenId)) return false;
    // 卡片摘要用 label 展示（用户看到的是选项名而非内部 value）
    const label = pending.options.find((option) => option.value === action.choice)?.label ?? action.choice;
    await this.finish("submitted", undefined, action.choice, label); return true;
  }
  async abort(): Promise<void> { if (this.pending) await this.finish("aborted", new Error("飞书澄清请求已取消")); }

  private async finish(status: "submitted" | "timeout" | "aborted", error?: Error, choice?: string, label?: string): Promise<void> {
    const pending = this.pending; if (!pending || pending.settled) return; pending.settled = true; clearTimeout(pending.timer);
    const summary = status === "submitted" ? `✅ 已选择：**${label ?? choice}**` : status === "timeout" ? "⌛ 澄清请求已超时" : "已取消澄清请求";
    try {
      await this.transport.batchUpdate(pending.cardId, [
        { action: "partial_update_element", params: { element_id: QUESTION_ELEMENT_ID, partial_element: { content: summary } } },
        // 选完/超时/取消后移除下拉框，避免残留可交互项
        { action: "delete_elements", params: { element_ids: [SELECT_ELEMENT_ID] } },
      ], ++this.sequence);
    } catch (err: any) {
      // 卡片更新失败不阻断澄清结果回传，保留日志便于诊断
      warn(`Clarify card update failed: ${err?.message ?? err}`);
    }
    this.pending = null; this.busy = false; if (error) pending.reject(error); else pending.resolve(choice ?? "");
  }

  /** schema 2.0 卡片：标题 + A/B/C 选项列表 + 底部下拉框（select_static），无 header（CardKit v2 不渲染） */
  private card(id: string, question: string, options: ClarifyOption[]): Record<string, unknown> {
    const letters = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];
    return {
      schema: "2.0",
      body: {
        elements: [
          { tag: "markdown", element_id: QUESTION_ELEMENT_ID, content: question, text_size: "title_2" },
          // 标题与选项列表之间的分隔线
          { tag: "hr" },
          // A/B/C 选项列表（label + 描述）
          ...options.map((option, index) => ({
            tag: "markdown",
            content: option.description
              ? `**${letters[index]}. ${option.label}** — ${option.description}`
              : `**${letters[index]}. ${option.label}**`,
            text_size: "notation",
          })),
          // 底部下拉框：value 携带 clarify_id，选中值经 action.option 回传
          {
            tag: "select_static",
            element_id: SELECT_ELEMENT_ID,
            options: options.map((option, index) => ({
              value: option.value,
              text: { tag: "plain_text", content: `${letters[index]}. ${option.label}` },
            })),
            placeholder: { tag: "plain_text", content: "请选择…" },
            value: { clarify_id: id },
          },
        ],
      },
    };
  }
}
