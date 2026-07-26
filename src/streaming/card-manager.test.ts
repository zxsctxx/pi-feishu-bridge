import { describe, expect, it } from "vitest";
import { StreamingCardManager, type StaticFallback, type StreamingManagerOptions } from "./card-manager.js";
import type { CardKitOperations } from "../feishu/cardkit-client.js";
import { CardKitError } from "../feishu/errors.js";

// ─── 测试替身 ─────────────────────────────────────────

type CardKitCall =
  | { op: "createCard" }
  | { op: "sendCardReference"; cardId: string }
  | { op: "updateElement"; cardId: string; elementId: string; content: string; sequence: number }
  | { op: "batchUpdate"; cardId: string; actions: unknown[]; sequence: number }
  | { op: "updateSettings"; cardId: string; settings: Record<string, unknown>; sequence: number };

/** 每个方法可注入一个抛错器；返回 undefined 表示放行 */
interface CardKitFailures {
  createCard?: (attempt: number) => unknown;
  sendCardReference?: (attempt: number) => unknown;
  updateElement?: (attempt: number) => unknown;
  batchUpdate?: (attempt: number) => unknown;
  updateSettings?: (attempt: number) => unknown;
}

class FakeCardKit implements CardKitOperations {
  readonly calls: CardKitCall[] = [];
  private counters: Record<string, number> = {};
  private cardSeq = 0;

  constructor(private readonly failures: CardKitFailures = {}) {}

  private maybeThrow(name: keyof CardKitFailures): void {
    const attempt = (this.counters[name] = (this.counters[name] ?? 0) + 1);
    const error = this.failures[name]?.(attempt);
    if (error) throw error;
  }

  async createCard(): Promise<string> {
    this.maybeThrow("createCard");
    const cardId = `card_${++this.cardSeq}`;
    this.calls.push({ op: "createCard" });
    return cardId;
  }

  async sendCardReference(_chatId: string, cardId: string): Promise<string> {
    this.maybeThrow("sendCardReference");
    this.calls.push({ op: "sendCardReference", cardId });
    return `msg_for_${cardId}`;
  }

  async updateElement(cardId: string, elementId: string, content: string, sequence: number): Promise<void> {
    this.maybeThrow("updateElement");
    this.calls.push({ op: "updateElement", cardId, elementId, content, sequence });
  }

  async batchUpdate(cardId: string, actions: unknown[], sequence: number): Promise<void> {
    this.maybeThrow("batchUpdate");
    this.calls.push({ op: "batchUpdate", cardId, actions, sequence });
  }

  async updateSettings(cardId: string, settings: Record<string, unknown>, sequence: number): Promise<void> {
    this.maybeThrow("updateSettings");
    this.calls.push({ op: "updateSettings", cardId, settings, sequence });
  }

  /** 该元素上收到的全部 content，按调用顺序 */
  contentsFor(elementId: string): string[] {
    return this.calls
      .filter((call): call is Extract<CardKitCall, { op: "updateElement" }> => call.op === "updateElement" && call.elementId === elementId)
      .map((call) => call.content);
  }

  countOf(op: CardKitCall["op"]): number {
    return this.calls.filter((call) => call.op === op).length;
  }

  /** 所有带 sequence 的调用，按发生顺序 */
  sequences(): number[] {
    return this.calls
      .filter((call): call is Extract<CardKitCall, { sequence: number }> => "sequence" in call)
      .map((call) => call.sequence);
  }
}

interface FallbackFailures {
  sendMessage?: boolean;
  sendCard?: boolean;
  updateCard?: boolean;
}

class FakeFallback implements StaticFallback {
  readonly messages: Array<{ chatId: string; text: string; replyTo?: string }> = [];
  readonly sentCards: Array<{ chatId: string; card: Record<string, unknown> }> = [];
  readonly patchedCards: Array<{ messageId: string; card: Record<string, unknown> }> = [];

  constructor(private readonly failures: FallbackFailures = {}) {}

  async sendMessage(chatId: string, text: string, replyToMsgId?: string): Promise<void> {
    if (this.failures.sendMessage) throw new Error("sendMessage failed");
    this.messages.push({ chatId, text, replyTo: replyToMsgId });
  }

  async sendCard(chatId: string, card: Record<string, unknown>): Promise<string | null> {
    if (this.failures.sendCard) throw new Error("sendCard failed");
    this.sentCards.push({ chatId, card });
    return `fallback_msg_${this.sentCards.length}`;
  }

  async updateCard(messageId: string, card: Record<string, unknown>): Promise<void> {
    if (this.failures.updateCard) throw new Error("updateCard failed");
    this.patchedCards.push({ messageId, card });
  }
}

function options(overrides: Partial<StreamingManagerOptions> = {}): StreamingManagerOptions {
  return {
    flushIntervalMs: 0,
    maxAnswerElementChars: 30000,
    showThinking: false,
    printStrategy: "delay",
    printStep: 4,
    panelExpanded: false,
    streamingPanelExpanded: false,
    maxToolSteps: 20,
    maxThinkingRounds: 20,
    maxReasoningChars: 3500,
    maxToolDetailChars: 500,
    maxToolOutputChars: 800,
    printFrequencyMs: 70,
    ...overrides,
  };
}

function manager(
  cardkit: FakeCardKit,
  fallback: FakeFallback,
  opts: Partial<StreamingManagerOptions> = {},
): StreamingCardManager {
  return new StreamingCardManager(cardkit, fallback, options(opts));
}

/** 所有交付文本拼接：卡片正文 + 纯文本消息，用于「内容不丢」断言 */
function deliveredText(cardkit: FakeCardKit, fallback: FakeFallback): string {
  return [
    ...cardkit.contentsFor("answer_content"),
    ...fallback.messages.map((m) => m.text),
    ...fallback.sentCards.map((c) => JSON.stringify(c.card)),
    ...fallback.patchedCards.map((c) => JSON.stringify(c.card)),
  ].join("\n");
}

// ─── 场景 1：正常流式路径 ──────────────────────────────

describe("正常 CardKit 流式路径", () => {
  it("建卡 → delta → settle，答案送达且 sequence 单调递增", async () => {
    const cardkit = new FakeCardKit();
    const fallback = new FakeFallback();
    const mgr = manager(cardkit, fallback);

    const session = await mgr.start("oc_chat", "om_user");
    expect(session.cardId).toBe("card_1");
    expect(session.cardMessageId).toBe("msg_for_card_1");

    mgr.onTextDelta("你好");
    mgr.onTextDelta("，世界");
    await mgr.settle();

    expect(cardkit.contentsFor("answer_content").at(-1)).toContain("你好，世界");

    const sequences = cardkit.sequences();
    expect(sequences.length).toBeGreaterThan(0);
    for (let i = 1; i < sequences.length; i++) {
      expect(sequences[i]).toBeGreaterThan(sequences[i - 1]);
    }

    // 终态应关闭 streaming_mode
    const settings = cardkit.calls.filter(
      (c): c is Extract<CardKitCall, { op: "updateSettings" }> => c.op === "updateSettings",
    );
    expect(settings.at(-1)?.settings.streaming_mode).toBe(false);

    // 正常路径不应触发任何纯文本兜底
    expect(fallback.messages).toHaveLength(0);
    expect(session.phase).toBe("completed");
    expect(session.terminalReason).toBe("normal");
  });

  it("记录 LLM 错误时终态为 failed", async () => {
    const cardkit = new FakeCardKit();
    const fallback = new FakeFallback();
    const mgr = manager(cardkit, fallback);

    await mgr.start("oc_chat", "om_user");
    mgr.onTextDelta("部分输出");
    mgr.recordError("provider 返回 500");
    const session = await mgr.settle();

    expect(session?.phase).toBe("failed");
    expect(session?.terminalReason).toBe("llm_error");
  });
});

// ─── 场景 6：message_unavailable ───────────────────────

describe("原消息被撤回（message_unavailable）", () => {
  it("流式中遇到 230011 时转为 terminated 且不再发纯文本", async () => {
    const cardkit = new FakeCardKit({
      updateElement: () => new CardKitError(230011, "message_unavailable", "message withdrawn"),
    });
    const fallback = new FakeFallback();
    const mgr = manager(cardkit, fallback);

    const session = await mgr.start("oc_chat", "om_user");
    mgr.onTextDelta("内容");
    await mgr.settle();

    expect(session.terminalReason).toBe("message_unavailable");
    expect(session.phase).toBe("terminated");
    // 消息已撤回，不应再打扰用户
    expect(fallback.messages).toHaveLength(0);
  });
});

// ─── 场景 7：空正文兜底 ────────────────────────────────

describe("空正文兜底", () => {
  it("无答案无错误时终态卡片写入 stop_reason 提示", async () => {
    const cardkit = new FakeCardKit();
    const fallback = new FakeFallback();
    const mgr = manager(cardkit, fallback);

    const session = await mgr.start("oc_chat", "om_user");
    session.footer.stopReason = "end_turn";
    await mgr.settle();

    expect(session.answer).toContain("未生成文本回复");
    expect(session.answer).toContain("end_turn");
  });

  it("建卡失败且无答案时纯文本仍可读", async () => {
    const cardkit = new FakeCardKit({ createCard: () => new Error("cardkit unavailable") });
    // sendCard 也失败 → 强制走纯文本
    const fallback = new FakeFallback({ sendCard: true });
    const mgr = manager(cardkit, fallback);

    const session = await mgr.start("oc_chat", "om_user");
    session.footer.stopReason = "end_turn";
    await mgr.settle();

    expect(fallback.messages).toHaveLength(1);
    expect(fallback.messages[0].text).toContain("未生成文本回复");
  });
});

// ─── 场景 8：长回答 rollover ───────────────────────────

describe("长回答 rollover 续卡", () => {
  it("超出上限时新建卡片，且全部内容不丢不重", async () => {
    const cardkit = new FakeCardKit();
    const fallback = new FakeFallback();
    const mgr = manager(cardkit, fallback, { maxAnswerElementChars: 100 });

    await mgr.start("oc_chat", "om_user");

    // 每段远超单卡上限的一小部分，累计必然触发多次续卡
    const paragraphs = Array.from({ length: 12 }, (_, i) => `段落${i}：${"内容".repeat(20)}`);
    for (const p of paragraphs) mgr.onTextDelta(`${p}\n\n`);
    await mgr.settle();

    // 至少建了 2 张卡
    expect(cardkit.countOf("createCard")).toBeGreaterThanOrEqual(2);

    // 每个段落都出现在某次投递中
    const all = deliveredText(cardkit, fallback);
    for (const p of paragraphs) {
      expect(all).toContain(p);
    }
  });

  it("答案未超上限时不触发 rollover", async () => {
    const cardkit = new FakeCardKit();
    const fallback = new FakeFallback();
    const mgr = manager(cardkit, fallback, { maxAnswerElementChars: 10000 });

    await mgr.start("oc_chat", "om_user");
    mgr.onTextDelta("短答案");
    await mgr.settle();

    expect(cardkit.countOf("createCard")).toBe(1);
  });
});

// ─── 建卡失败降级（当前 im_patch 行为基线）────────────

describe("建卡失败降级", () => {
  it("CardKit 建卡失败时改用静态卡承接，并在终态交付答案", async () => {
    const cardkit = new FakeCardKit({ createCard: () => new Error("cardkit unavailable") });
    const fallback = new FakeFallback();
    const mgr = manager(cardkit, fallback);

    const session = await mgr.start("oc_chat", "om_user");
    expect(session.cardId).toBeNull();
    expect(fallback.sentCards).toHaveLength(1);

    mgr.onTextDelta("降级后的答案");
    await mgr.settle();

    // 内容必须以某种形式送达
    expect(deliveredText(cardkit, fallback)).toContain("降级后的答案");
  });

  it("建卡失败且静态卡也失败时走纯文本必达", async () => {
    const cardkit = new FakeCardKit({ createCard: () => new Error("cardkit unavailable") });
    const fallback = new FakeFallback({ sendCard: true, updateCard: true });
    const mgr = manager(cardkit, fallback);

    await mgr.start("oc_chat", "om_user");
    mgr.onTextDelta("纯文本兜底内容");
    await mgr.settle();

    expect(fallback.messages).toHaveLength(1);
    expect(fallback.messages[0].text).toContain("纯文本兜底内容");
  });

  it("占位卡在流式期间不被更新，仅终态 PATCH 一次", async () => {
    const cardkit = new FakeCardKit({ createCard: () => new Error("cardkit unavailable") });
    const fallback = new FakeFallback();
    const mgr = manager(cardkit, fallback);

    const session = await mgr.start("oc_chat", "om_user");
    expect(fallback.sentCards).toHaveLength(1);
    expect(session.staticCardMessageId).toBe("fallback_msg_1");

    // 流式期间的多次事件都不应触发卡片更新
    mgr.onTextDelta("第一段");
    mgr.onThinkingDelta("推理中");
    mgr.onToolStart("t1", "bash", { cmd: "ls" });
    mgr.onToolEnd("t1", "done", false);
    mgr.onTextDelta("第二段");
    expect(fallback.patchedCards).toHaveLength(0);

    await mgr.settle();

    expect(fallback.patchedCards).toHaveLength(1);
    expect(fallback.patchedCards[0].messageId).toBe("fallback_msg_1");
    expect(deliveredText(cardkit, fallback)).toContain("第一段");
    expect(deliveredText(cardkit, fallback)).toContain("第二段");
  });
});

// ─── 流式中断 ──────────────────────────────────────────

describe("流式中途失败", () => {
  it("原生更新中断后答案仍然送达用户", async () => {
    const cardkit = new FakeCardKit({
      updateElement: () => new CardKitError(300309, "streaming_closed", "streaming closed"),
      batchUpdate: (attempt) =>
        // 首次 ensureStreamingElements 放行，之后的恢复尝试全部失败
        attempt === 1 ? undefined : new CardKitError(300309, "streaming_closed", "streaming closed"),
    });
    const fallback = new FakeFallback();
    const mgr = manager(cardkit, fallback);

    const session = await mgr.start("oc_chat", "om_user");
    mgr.onTextDelta("中断前的内容");
    await mgr.settle();

    expect(session.degraded).toBe(true);
    expect(deliveredText(cardkit, fallback)).toContain("中断前的内容");
  });

  it("降级后不再调用任何 CardKit 原生接口", async () => {
    const cardkit = new FakeCardKit({
      updateElement: () => new CardKitError(300309, "streaming_closed", "streaming closed"),
      batchUpdate: (attempt) => (attempt === 1 ? undefined : new CardKitError(300309, "streaming_closed", "streaming closed")),
    });
    const fallback = new FakeFallback();
    const mgr = manager(cardkit, fallback);

    const session = await mgr.start("oc_chat", "om_user");
    mgr.onTextDelta("触发降级");
    // 首次 flush 触发降级
    await mgr["flushSession"](session);
    expect(session.degraded).toBe(true);

    const callsAfterDegrade = cardkit.calls.length;
    mgr.onTextDelta("降级之后的增量");
    mgr.onToolStart("t1", "bash", { cmd: "ls" });
    mgr.onToolEnd("t1", "ok", false);
    await mgr.settle();

    // 降级后只允许静态卡 / 纯文本，不应再有原生调用
    expect(cardkit.calls.length).toBe(callsAfterDegrade);
    expect(deliveredText(cardkit, fallback)).toContain("降级之后的增量");
  });

  it("流式中断时把原生卡 PATCH 成终态，不留转圈半成品", async () => {
    const cardkit = new FakeCardKit({
      updateElement: () => new CardKitError(300309, "streaming_closed", "streaming closed"),
      batchUpdate: (attempt) => (attempt === 1 ? undefined : new CardKitError(300309, "streaming_closed", "streaming closed")),
    });
    const fallback = new FakeFallback();
    const mgr = manager(cardkit, fallback);

    const session = await mgr.start("oc_chat", "om_user");
    mgr.onTextDelta("需要保住的内容");
    await mgr.settle();

    // 应对已存在的原生卡消息 PATCH 一次终态静态卡
    expect(fallback.patchedCards).toHaveLength(1);
    expect(fallback.patchedCards[0].messageId).toBe(session.cardMessageId);
    // 已用卡片交付，不应再多发一条纯文本
    expect(fallback.messages).toHaveLength(0);
  });
});

// ─── 终态幂等性 ────────────────────────────────────────

describe("终态与幂等性", () => {
  it("abort 后再 settle 不重复交付", async () => {
    const cardkit = new FakeCardKit();
    const fallback = new FakeFallback();
    const mgr = manager(cardkit, fallback);

    await mgr.start("oc_chat", "om_user");
    mgr.onTextDelta("部分内容");
    const aborted = await mgr.abort("用户已停止当前任务");
    expect(aborted?.phase).toBe("aborted");
    expect(aborted?.terminalReason).toBe("user_abort");

    const settingsAfterAbort = cardkit.countOf("updateSettings");
    const messagesAfterAbort = fallback.messages.length;

    await mgr.settle();

    expect(cardkit.countOf("updateSettings")).toBe(settingsAfterAbort);
    expect(fallback.messages.length).toBe(messagesAfterAbort);
  });

  it("terminate 标记 session_shutdown 终态", async () => {
    const cardkit = new FakeCardKit();
    const fallback = new FakeFallback();
    const mgr = manager(cardkit, fallback);

    await mgr.start("oc_chat", "om_user");
    const session = await mgr.terminate("会话已关闭");

    expect(session?.phase).toBe("terminated");
    expect(session?.terminalReason).toBe("session_shutdown");
  });

  it("新请求到来时取代旧会话", async () => {
    const cardkit = new FakeCardKit();
    const fallback = new FakeFallback();
    const mgr = manager(cardkit, fallback);

    const first = await mgr.start("oc_chat", "om_user_1");
    mgr.onTextDelta("第一轮");
    const second = await mgr.start("oc_chat", "om_user_2");

    expect(first.terminalReason).toBe("replaced");
    expect(second).not.toBe(first);
    expect(mgr.activeSession).toBe(second);
  });
});
