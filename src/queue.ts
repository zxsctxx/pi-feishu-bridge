/**
 * 每个聊天一条消息队列。
 *
 * 全局约束：一个 Pi 扩展实例只绑定一个 Pi session，因此同一时刻
 * 只允许一个 chat 处于 processing。跨 chat 的消息互相排队，
 * 由 `isAgentIdle` 回调判断 Pi 侧是否空闲。
 */

import type { InboundResource } from "./types.js";

export interface QueuedMessage {
  msgId: string;
  text: string;
  resources: InboundResource[];
  chatType: "p2p" | "group";
}

interface ChatQueue {
  processing: boolean;
  queue: QueuedMessage[];
}

/** 同 chat 已有任务在跑时的处理方式 */
export type BusyPolicy = "queue" | "interrupt";

export type EnqueueOutcome =
  /** 队列空闲，调用方应立即开始处理 */
  | { action: "process" }
  /** 已排队，`pending` 为全局待处理条数 */
  | { action: "queued"; pending: number }
  /** 打断了当前任务；`dropped` 为被丢弃的排队条数，`agentBusy` 表示需等 settled */
  | { action: "interrupted"; dropped: number; agentBusy: boolean };

export interface QueueHooks {
  /** Pi 侧是否空闲；忙时不出队，等 agent_settled 再 flush */
  isAgentIdle(): boolean;
}

export class MessageQueueManager {
  private readonly queues = new Map<string, ChatQueue>();

  constructor(private readonly hooks: QueueHooks) {}

  private queueFor(chatId: string): ChatQueue {
    let queue = this.queues.get(chatId);
    if (!queue) {
      queue = { processing: false, queue: [] };
      this.queues.set(chatId, queue);
    }
    return queue;
  }

  /** 全局待处理条数，用于「前面还有 N 条」提示 */
  pendingCount(): number {
    let total = 0;
    for (const queue of this.queues.values()) total += queue.queue.length;
    return total;
  }

  /** 某个 chat 的待处理条数 */
  pendingFor(chatId: string): number {
    return this.queues.get(chatId)?.queue.length ?? 0;
  }

  isProcessing(chatId: string): boolean {
    return this.queues.get(chatId)?.processing ?? false;
  }

  /** 是否有任意 chat 正在处理 */
  anyProcessing(): boolean {
    for (const queue of this.queues.values()) {
      if (queue.processing) return true;
    }
    return false;
  }

  private otherChatProcessing(chatId: string): boolean {
    for (const [id, queue] of this.queues) {
      if (id !== chatId && queue.processing) return true;
    }
    return false;
  }

  setProcessing(chatId: string, processing: boolean): void {
    this.queueFor(chatId).processing = processing;
  }

  /** 清空某个 chat 的队列并置为空闲（会话控制命令用） */
  reset(chatId: string): void {
    const queue = this.queueFor(chatId);
    queue.queue = [];
    queue.processing = false;
  }

  /**
   * 入队一条消息并决定下一步。
   *
   * `streamingSameChat` 表示该 chat 当前是否有活跃的流式卡片——
   * 卡片可能仍在收尾而队列已标记空闲，两者需一起判断是否「忙」。
   */
  enqueue(
    chatId: string,
    message: QueuedMessage,
    policy: BusyPolicy,
    streamingSameChat: boolean,
  ): EnqueueOutcome {
    const queue = this.queueFor(chatId);
    const sameChatBusy = queue.processing || streamingSameChat;

    if (sameChatBusy && policy === "interrupt") {
      const dropped = queue.queue.length;
      // 丢弃本 chat 全部排队，只保留最新一条
      queue.queue = [message];
      const agentBusy = !this.hooks.isAgentIdle();
      // agent 仍在跑时等 agent_settled 清 processing；否则调用方直接出队
      queue.processing = agentBusy;
      return { action: "interrupted", dropped, agentBusy };
    }

    queue.queue.push(message);

    if (sameChatBusy || this.otherChatProcessing(chatId) || !this.hooks.isAgentIdle()) {
      return { action: "queued", pending: this.pendingCount() };
    }
    return { action: "process" };
  }

  /**
   * 取出下一条待处理消息。
   *
   * 返回 null 表示本次不应处理：队列为空、Pi 正忙、或另一个 chat 占用中。
   * 三种情况都会把 processing 置回 false，等下一次 flush 重试。
   */
  dequeue(chatId: string): QueuedMessage | null {
    const queue = this.queues.get(chatId);
    if (!queue || queue.queue.length === 0) {
      if (queue) queue.processing = false;
      return null;
    }
    if (!this.hooks.isAgentIdle() || this.otherChatProcessing(chatId)) {
      queue.processing = false;
      return null;
    }
    queue.processing = true;
    return queue.queue.shift()!;
  }

  /** 有待处理消息且未在处理中的 chat，按插入顺序 */
  chatsAwaitingFlush(): string[] {
    const ids: string[] = [];
    for (const [chatId, queue] of this.queues) {
      if (!queue.processing && queue.queue.length > 0) ids.push(chatId);
    }
    return ids;
  }

  /** 队列状态摘要，供 /queue 与 /status 使用 */
  summary(): { chats: number; pending: number; processing: string[] } {
    const processing: string[] = [];
    for (const [chatId, queue] of this.queues) {
      if (queue.processing) processing.push(chatId);
    }
    return { chats: this.queues.size, pending: this.pendingCount(), processing };
  }
}
