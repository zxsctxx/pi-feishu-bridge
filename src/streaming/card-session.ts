import { FlushScheduler } from "./flush-scheduler.js";
import { ToolTracker } from "./tool-tracker.js";
import { UpdateQueue } from "./update-queue.js";

export type CardPhase = "creating" | "streaming" | "completing" | "completed" | "failed" | "aborted" | "terminated";
export type TerminalReason = "normal" | "llm_error" | "user_abort" | "timeout" | "replaced" | "message_unavailable" | "session_shutdown";
export interface FooterMetrics {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** 最近一次请求的 cache hit rate（%），口径对齐终端 footer CH */
  cacheHitPercent?: number;
  cost?: number;
  contextTokens?: number | null;
  contextWindow?: number;
  contextPercent?: number | null;
  apiCalls: number;
  stopReason?: string;
}

const TRANSITIONS: Record<CardPhase, CardPhase[]> = {
  creating: ["streaming", "completing", "failed", "aborted", "terminated"],
  streaming: ["completing", "failed", "aborted", "terminated"],
  completing: ["completed", "failed", "aborted", "terminated"],
  completed: [], failed: [], aborted: [], terminated: [],
};

export class CardSession {
  phase: CardPhase = "creating";
  terminalReason: TerminalReason | null = null;
  terminalSource = "";
  cardId: string | null = null;
  cardMessageId: string | null = null;
  /** 降级时承接内容的静态卡消息 id（建卡失败时创建） */
  staticCardMessageId: string | null = null;
  /** 终态静态卡是否已交付，避免重复投递 */
  staticCardDelivered = false;
  answer = "";
  deliveredAnswerLength = 0;
  currentThinking = "";
  thinkingRounds: string[] = [];
  panelEvents: Array<{ type: "thinking"; index: number } | { type: "tool"; toolCallId: string }> = [];
  errorMessage = "";
  panelDirty = true;
  answerDirty = false;
  sequence = 0;
  epoch = 0;
  readonly tools: ToolTracker;
  readonly flush: FlushScheduler;
  readonly updates = new UpdateQueue();
  /** 建卡/接住本轮请求的墙钟起点（footer 整轮耗时用） */
  readonly createdAt = Date.now();
  completedAt: number | null = null;
  /** 首次推理/工具活动；过程面板耗时起点 */
  loopStartedAt: number | null = null;
  /** 最近一次推理/工具活动；过程面板耗时终点 */
  loopActiveAt: number | null = null;
  finalized = false;
  currentCardStart = 0;
  /**
   * CardKit 原生路径已不可用，后续只走静态卡 / 纯文本。
   * 与 phase 正交：降级不改变会话生命周期阶段。
   */
  degraded = false;
  degradeReason = "";
  nativeErrorCode: number | undefined;
  nativeErrorKind = "";
  elementsInitialized = false;
  footer: FooterMetrics = { apiCalls: 0 };

  constructor(
    readonly requestId: string,
    readonly chatId: string,
    readonly userMsgId: string,
    flushIntervalMs: number,
    toolLimits?: { detailChars?: number; outputChars?: number },
  ) {
    this.tools = new ToolTracker(toolLimits);
    this.flush = new FlushScheduler(flushIntervalMs);
  }

  get terminal(): boolean { return TRANSITIONS[this.phase].length === 0; }
  nextSequence(): number { return ++this.sequence; }

  transition(next: CardPhase, reason?: TerminalReason, source = ""): boolean {
    if (this.phase === next || !TRANSITIONS[this.phase].includes(next)) return false;
    this.phase = next;
    if (TRANSITIONS[next].length === 0) {
      this.terminalReason = reason ?? this.terminalReason;
      this.terminalSource = source;
      this.completedAt = Date.now();
    }
    return true;
  }

  beginStreaming(): void { if (this.phase === "creating") this.transition("streaming"); }

  /** 标记 agent 过程活动（推理/工具），供面板标题耗时使用 */
  markLoopActivity(at: number = Date.now()): void {
    if (this.loopStartedAt == null) this.loopStartedAt = at;
    this.loopActiveAt = at;
  }

  /** footer：建卡 → 终态的整轮墙钟（秒） */
  wallClockSeconds(end: number = this.completedAt ?? Date.now()): number {
    return Math.max(0, (end - this.createdAt) / 1000);
  }

  /**
   * 过程面板：首次活动 → 最近活动的墙钟（秒）。
   * 终态用 loopActiveAt；流式中用 now，便于标题随过程推进。
   * 尚无活动时返回 0。
   */
  loopSeconds(terminal = false, now: number = Date.now()): number {
    if (this.loopStartedAt == null) return 0;
    const end = terminal
      ? (this.loopActiveAt ?? this.completedAt ?? now)
      : now;
    return Math.max(0, (end - this.loopStartedAt) / 1000);
  }

  appendText(delta: string): void { if (!this.terminal && delta) { this.finishThinking(); this.beginStreaming(); this.answer += delta; this.answerDirty = true; } }
  appendThinking(delta: string): void {
    if (!this.terminal && delta) {
      this.beginStreaming();
      this.markLoopActivity();
      this.currentThinking += delta;
      this.panelDirty = true;
    }
  }
  recordTool(toolCallId: string): void {
    if (this.panelEvents.some((event) => event.type === "tool" && event.toolCallId === toolCallId)) return;
    this.finishThinking();
    this.beginStreaming();
    this.markLoopActivity();
    this.panelEvents.push({ type: "tool", toolCallId });
    this.panelDirty = true;
  }
  finishThinking(): void {
    if (!this.currentThinking) return;
    this.thinkingRounds.push(this.currentThinking);
    this.panelEvents.push({ type: "thinking", index: this.thinkingRounds.length - 1 });
    this.currentThinking = "";
    this.markLoopActivity();
    this.panelDirty = true;
  }
}
