import type { CardKitOperations } from "../feishu/cardkit-client.js";
import { CardKitError, isCardIdInvalidError } from "../feishu/errors.js";
import { normalizeMarkdown, splitMarkdown } from "../cardkit/markdown.js";
import { trimPanelToTagLimit } from "../cardkit/limits.js";
import { CardSession, type TerminalReason } from "./card-session.js";
import { ANSWER_ELEMENT_ID, LOADING_ELEMENT_ID, LOADING_HINT_ELEMENT_ID, PANEL_ELEMENT_ID, addElementsAction, buildCreatingCard, buildFallbackCard, buildFallbackText, buildPanelElement, deleteElementsAction, footerElements, partialUpdateElementAction, type CardRenderOptions } from "./card-renderer.js";
import type { MetricsCollector } from "../monitoring/metrics.js";

export interface StreamingManagerOptions extends CardRenderOptions { flushIntervalMs: number; maxAnswerElementChars: number; }
export interface StaticFallback {
  sendMessage(chatId: string, text: string, replyToMsgId?: string): Promise<void>;
  sendCard?(chatId: string, card: Record<string, unknown>, replyToMsgId?: string): Promise<string | null>;
  updateCard?(messageId: string, card: Record<string, unknown>): Promise<void>;
}

export class StreamingCardManager {
  private active: CardSession | null = null;
  constructor(private readonly cardkit: CardKitOperations, private readonly fallback: StaticFallback, private readonly options: StreamingManagerOptions, private readonly metrics?: MetricsCollector) {}
  get activeSession(): CardSession | null { return this.active; }

  async start(chatId: string, userMsgId: string): Promise<CardSession> {
    if (this.active && !this.active.terminal) await this.abort("被新请求取代", "replaced");
    const session = new CardSession(`${Date.now()}-${userMsgId}`, chatId, userMsgId, this.options.flushIntervalMs, {
      detailChars: this.options.maxToolDetailChars,
      outputChars: this.options.maxToolOutputChars,
    }); this.active = session;
    this.metrics?.setActive(1);
    try {
      await this.bootstrapCardKit(session);
    } catch (error) {
      // create/send/重建均失败 → 降级；清掉无效 cardId，避免后续误用
      session.cardId = null;
      session.cardMessageId = null;
      this.degrade(session, error);
      await this.sendPlaceholderCard(session);
    }
    return session;
  }

  /**
   * CardKit 优先：create → send(含同 id 重试) → 仍 card_id invalid 则重建一次再 send。
   * 成功写入 session.cardId / cardMessageId；失败抛错由 start 转降级。
   */
  private async bootstrapCardKit(session: CardSession): Promise<void> {
    const cardJson = buildCreatingCard(this.options);
    session.cardId = await this.cardkit.createCard(cardJson);
    this.metrics?.increment("cardsCreated");
    try {
      session.cardMessageId = await this.cardkit.sendCardReference(session.chatId, session.cardId, session.userMsgId);
      return;
    } catch (error) {
      if (!isCardIdInvalidError(error)) throw error;
      console.warn(`[pi-feishu] Card reference still invalid after retries; recreating card once. old_card_id=${session.cardId}`);
    }
    // 重建：旧 id 作废，新 create + send（send 内部仍有短延迟重试）
    session.cardId = await this.cardkit.createCard(cardJson);
    this.metrics?.increment("cardsCreated");
    this.metrics?.increment("retries");
    session.cardMessageId = await this.cardkit.sendCardReference(session.chatId, session.cardId, session.userMsgId);
  }

  /**
   * 建卡失败后立即占位一张静态卡，避免用户面对空白等待。
   * 流式期间不再更新它；finalize 时 PATCH 一次终态。
   */
  private async sendPlaceholderCard(session: CardSession): Promise<void> {
    if (!this.fallback.sendCard) return;
    try {
      session.staticCardMessageId = await this.fallback.sendCard(
        session.chatId,
        buildFallbackCard(session, this.options, false),
        session.userMsgId,
      );
    } catch {
      session.staticCardMessageId = null;
    }
  }

  private accepts(s: CardSession): boolean { return !s.terminal; }
  onTextDelta(delta: string): void { const s = this.active; if (!s || !this.accepts(s)) return; s.appendText(delta); this.schedule(s); }
  onThinkingDelta(delta: string): void {
    const s = this.active; if (!s || !this.accepts(s)) return;
    const startedRound = !s.currentThinking;
    s.appendThinking(delta);
    // 新一轮推理开始时立刻刷新标题轮次；流式中仍走节流
    if (startedRound) this.flushImmediate(s);
    else this.schedule(s);
  }
  onToolStart(id: string, name: string, args: unknown): void {
    const s = this.active; if (!s || !this.accepts(s)) return;
    s.recordTool(id); s.tools.start(id, name, args); s.markLoopActivity(); s.panelDirty = true; this.flushImmediate(s);
  }
  onToolUpdate(id: string, result: unknown): void {
    const s = this.active; if (!s || !this.accepts(s)) return;
    if (s.tools.update(id, result)) s.recordTool(id);
    s.markLoopActivity(); s.panelDirty = true; this.schedule(s);
  }
  onToolEnd(id: string, result: unknown, error: boolean): void {
    const s = this.active; if (!s || !this.accepts(s)) return;
    if (s.tools.end(id, result, error)) s.recordTool(id);
    s.markLoopActivity(); s.panelDirty = true; this.flushImmediate(s);
  }
  recordError(message: string): void { const s = this.active; if (!s || !this.accepts(s)) return; s.errorMessage = message; }
  onAgentEnd(): void {
    const s = this.active; if (!s || !this.accepts(s)) return;
    s.finishThinking(); s.panelDirty = true; this.flushImmediate(s);
  }

  async settle(): Promise<CardSession | null> {
    const s = this.active; if (!s) return null; s.finishThinking();
    if (s.terminal) { await this.finalize(s); return s; }
    s.transition("completing");
    await s.flush.flushNow(() => this.flushSession(s)); await s.updates.drain();
    s.transition(s.errorMessage ? "failed" : "completed", s.errorMessage ? "llm_error" : "normal", "agent_settled");
    await this.finalize(s); return s;
  }

  async abort(message = "用户已停止当前任务", reason: TerminalReason = "user_abort"): Promise<CardSession | null> {
    const s = this.active; if (!s || s.terminal) return s;
    s.errorMessage = message; s.finishThinking();
    s.transition("aborted", reason, "abort");
    s.flush.complete(); await s.updates.drain(); await this.finalize(s); return s;
  }
  async terminate(message = "会话已关闭"): Promise<CardSession | null> {
    const s = this.active; if (!s || s.terminal) return s;
    s.errorMessage = message;
    s.transition("terminated", "session_shutdown", "session_shutdown");
    s.flush.complete(); await s.updates.drain(); await this.finalize(s); return s;
  }
  release(): void { this.active = null; }
  private schedule(s: CardSession): void { s.flush.schedule(() => this.flushSession(s)); }
  /** 关键事件（新轮推理 / 工具开始结束）立即刷新，避免标题卡住 */
  private flushImmediate(s: CardSession): void { void s.flush.flushNow(() => this.flushSession(s)); }

  private async flushSession(s: CardSession): Promise<void> {
    // 降级后流式期间不做任何投递，内容统一在 finalize 交付
    if (s.degraded || s.terminal || !s.cardId) return;
    this.metrics?.increment("flushes");
    const answer = s.answerDirty; const panel = s.panelDirty; s.answerDirty = false; s.panelDirty = false;
    try {
      const initializedNow = await this.ensureStreamingElements(s);
      if (answer) await this.flushAnswer(s);
      if (panel && !initializedNow) await this.flushPanel(s);
    } catch (error) {
      this.degrade(s, error);
    }
  }

  private async finalize(s: CardSession): Promise<void> {
    if (s.finalized) return;
    s.finalized = true;
    s.flush.complete();
    // 空正文时写入可读兜底，避免终态卡片只剩空白
    if (!(s.answer || "").trim() && !(s.errorMessage || "").trim()) {
      const stop = s.footer.stopReason ? `stop_reason=${s.footer.stopReason}` : "";
      s.answer = stop
        ? `处理结束，但未生成文本回复。\n${stop}`
        : "处理结束，但未生成文本回复。";
      s.answerDirty = true;
    }
    if (s.degraded || !s.cardId) {
      await this.deliverDegraded(s);
      this.metrics?.setActive(0);
      return;
    }
    try {
      await this.ensureStreamingElements(s);
      if (s.answerDirty) await this.flushAnswer(s);
      const terminalPanel = trimPanelToTagLimit(buildPanelElement(s, this.options, true), 190) as {
        header?: unknown;
        elements?: unknown;
      };
      const footerEls = footerElements(s, this.options.footer);
      const terminalActions = [
        partialUpdateElementAction(PANEL_ELEMENT_ID, { header: terminalPanel.header, elements: terminalPanel.elements }),
        ...(footerEls.length > 0 ? [addElementsAction(footerEls, LOADING_ELEMENT_ID)] : []),
        deleteElementsAction([LOADING_ELEMENT_ID]),
      ];
      try { await s.updates.enqueue(() => this.cardkit.batchUpdate(s.cardId!, terminalActions, s.nextSequence())); }
      catch (error) {
        if ((error as CardKitError)?.kind !== "element_limit") throw error;
        const minimalPanel = {
          tag: "collapsible_panel",
          element_id: PANEL_ELEMENT_ID,
          expanded: false,
          header: { title: { tag: "plain_text", content: "Agent loop · 详细步骤已裁剪", text_size: "notation" } },
          elements: [{ tag: "markdown", content: "早期步骤因卡片元素限制已折叠。", text_size: "notation" }],
        };
        await s.updates.enqueue(() => this.cardkit.batchUpdate(s.cardId!, [
          partialUpdateElementAction(PANEL_ELEMENT_ID, { header: minimalPanel.header, elements: minimalPanel.elements }),
          ...(footerEls.length > 0 ? [addElementsAction(footerEls, LOADING_ELEMENT_ID)] : []),
          deleteElementsAction([LOADING_ELEMENT_ID]),
        ], s.nextSequence()));
      }
      await s.updates.enqueue(() => this.cardkit.updateSettings(s.cardId!, { streaming_mode: false, summary: { content: (s.answer || s.errorMessage || "处理结束").slice(0, 120) } }, s.nextSequence()));
      await s.updates.drain();
      this.metrics?.recordFinalize();
      this.metrics?.setActive(0);
    } catch (error) {
      this.degrade(s, error);
      await this.deliverDegraded(s);
      this.metrics?.setActive(0);
    }
  }

  /**
   * 降级交付：静态卡优先，失败则纯文本必达。
   * 原消息已撤回时不再投递，避免无意义打扰。
   */
  private async deliverDegraded(s: CardSession): Promise<void> {
    if (s.terminalReason === "message_unavailable") return;
    this.metrics?.increment("fallbacks");
    if (await this.deliverStaticCard(s)) return;
    await this.deliverFinalText(s);
  }

  /**
   * 终态静态卡：优先复用已存在的卡片消息（占位卡 → 原生卡），都不可用时新发一张。
   * 对原生卡 PATCH 是必要的——流式中断的卡片会永远停在转圈状态。
   */
  private async deliverStaticCard(s: CardSession): Promise<boolean> {
    if (s.staticCardDelivered) return true;
    const card = buildFallbackCard(s, this.options, true);
    for (const messageId of [s.staticCardMessageId, s.cardMessageId]) {
      if (!messageId || !this.fallback.updateCard) continue;
      try {
        await this.fallback.updateCard(messageId, card);
        s.staticCardDelivered = true;
        return true;
      } catch { /* 试下一个目标 */ }
    }
    if (!this.fallback.sendCard) return false;
    try {
      const messageId = await this.fallback.sendCard(s.chatId, card, s.userMsgId);
      s.staticCardDelivered = messageId !== null;
      return s.staticCardDelivered;
    } catch {
      return false;
    }
  }

  /** 最终必达：整份 fallback 文本（含答案/错误），避免飞书侧空白；空正文走 stop_reason/错误兜底 */
  private async deliverFinalText(s: CardSession): Promise<void> {
    const text = buildFallbackText(s, this.options)
      || (s.answer || "").trim()
      || (s.errorMessage ? `处理失败：${s.errorMessage}` : "")
      || (s.footer.stopReason ? `处理结束，但未生成文本回复。\nstop_reason=${s.footer.stopReason}` : "")
      || "处理结束，但未生成文本回复。";
    try {
      // sendMessage 内部已按卡片长度切分
      await this.fallback.sendMessage(s.chatId, text, s.userMsgId);
    } catch (error) {
      console.warn(`[pi-feishu] Final text delivery failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  private describe(error: unknown): string { return (error as CardKitError)?.message ?? String(error); }

  private async flushAnswer(s: CardSession): Promise<void> {
    while (s.answer.length - s.currentCardStart > this.options.maxAnswerElementChars) {
      const remaining = s.answer.slice(s.currentCardStart); const split = splitMarkdown(remaining, this.options.maxAnswerElementChars);
      await this.updateAnswerWithRecovery(s, normalizeMarkdown(split.head), s.currentCardStart + split.consumed);
      await s.updates.enqueue(() => this.cardkit.updateSettings(s.cardId!, { streaming_mode: false, summary: { content: split.head.slice(0, 120) } }, s.nextSequence()));
      this.metrics?.increment("rollovers");
      s.currentCardStart += split.consumed;
      s.cardId = await this.cardkit.createCard(buildCreatingCard(this.options));
      this.metrics?.increment("cardsCreated");
      s.cardMessageId = await this.cardkit.sendCardReference(s.chatId, s.cardId, s.userMsgId);
      s.elementsInitialized = false;
      await this.ensureStreamingElements(s);
    }
    await this.updateAnswerWithRecovery(s, normalizeMarkdown(s.answer.slice(s.currentCardStart)), s.answer.length);
  }

  private async updateAnswerWithRecovery(s: CardSession, content: string, deliveredLength: number): Promise<void> {
    if (!content) return;
    try { await s.updates.enqueue(() => this.cardkit.updateElement(s.cardId!, ANSWER_ELEMENT_ID, content, s.nextSequence())); }
    catch (error) {
      const kind = (error as CardKitError)?.kind;
      // 流式通道关闭/元素暂不可用时，改用整元素替换再试一次
      if (kind === "element_unavailable" || kind === "streaming_closed") {
        await s.updates.enqueue(() => this.cardkit.batchUpdate(s.cardId!, [partialUpdateElementAction(ANSWER_ELEMENT_ID, { content })], s.nextSequence()));
      } else throw error;
    }
    s.deliveredAnswerLength = deliveredLength;
  }

  private async flushPanel(s: CardSession): Promise<void> {
    // 同步刷新标题（轮次/工具数/耗时）与面板内容；仅改 content 时标题不会变
    const panel = trimPanelToTagLimit(buildPanelElement(s, this.options), 190) as {
      header?: unknown;
      elements?: unknown;
    };
    try {
      await s.updates.enqueue(() => this.cardkit.batchUpdate(s.cardId!, [
        partialUpdateElementAction(PANEL_ELEMENT_ID, { header: panel.header, elements: panel.elements }),
      ], s.nextSequence()));
    } catch (error) {
      if ((error as CardKitError)?.kind !== "element_limit") throw error;
      const minimal = {
        tag: "collapsible_panel",
        element_id: PANEL_ELEMENT_ID,
        expanded: false,
        header: { title: { tag: "plain_text", content: "Agent loop · 早期步骤已裁剪", text_size: "notation" } },
        elements: [{ tag: "markdown", content: "详细步骤因卡片元素限制已折叠。", text_size: "notation" }],
      };
      await s.updates.enqueue(() => this.cardkit.batchUpdate(s.cardId!, [
        partialUpdateElementAction(PANEL_ELEMENT_ID, { header: minimal.header, elements: minimal.elements }),
      ], s.nextSequence()));
    }
  }

  private async ensureStreamingElements(s: CardSession): Promise<boolean> {
    if (s.elementsInitialized) return false;
    const panel = trimPanelToTagLimit(buildPanelElement(s, this.options), 190);
    const answerElement = { tag: "markdown", element_id: ANSWER_ELEMENT_ID, content: "", text_align: "left", text_size: "normal_v2" };
    try {
      await s.updates.enqueue(() => this.cardkit.batchUpdate(s.cardId!, [
        addElementsAction([panel, answerElement], LOADING_HINT_ELEMENT_ID),
        deleteElementsAction([LOADING_HINT_ELEMENT_ID]),
      ], s.nextSequence()));
    } catch (error) {
      if ((error as CardKitError)?.kind !== "element_limit") throw error;
      const minimalPanel = {
        tag: "collapsible_panel",
        element_id: PANEL_ELEMENT_ID,
        expanded: false,
        header: { title: { tag: "plain_text", content: "Agent loop · 详细步骤已裁剪", text_size: "notation" } },
        elements: [{ tag: "markdown", content: "详细步骤因卡片元素限制已折叠。", text_size: "notation" }],
      };
      await s.updates.enqueue(() => this.cardkit.batchUpdate(s.cardId!, [
        addElementsAction([minimalPanel, answerElement], LOADING_HINT_ELEMENT_ID),
        deleteElementsAction([LOADING_HINT_ELEMENT_ID]),
      ], s.nextSequence()));
    }
    s.elementsInitialized = true;
    return true;
  }

  /** 标记 CardKit 原生路径不可用；只记录状态，实际交付统一在 finalize */
  private degrade(s: CardSession, error: unknown): void {
    if (s.degraded) return;
    s.degraded = true;
    const kind = (error as CardKitError)?.kind;
    s.nativeErrorCode = (error as CardKitError)?.code;
    s.nativeErrorKind = kind ?? "unknown";
    const message = this.describe(error);
    this.metrics?.recordError(String(s.nativeErrorCode ?? kind ?? "unknown"), message);
    if (kind === "message_unavailable") {
      s.transition("terminated", "message_unavailable", "cardkit");
      return;
    }
    s.degradeReason ||= `CardKit ${s.nativeErrorCode ?? "unknown"}/${s.nativeErrorKind}: ${message}`;
    console.warn(`[pi-feishu] CardKit degraded to static card: code=${s.nativeErrorCode ?? "unknown"} kind=${s.nativeErrorKind} message=${message}`);
  }
}
