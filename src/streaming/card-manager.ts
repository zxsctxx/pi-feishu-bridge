import type { CardKitOperations } from "../feishu/cardkit-client.js";
import type { CardKitError } from "../feishu/errors.js";
import { normalizeMarkdown, splitMarkdown } from "../cardkit/markdown.js";
import { trimPanelToTagLimit } from "../cardkit/limits.js";
import { CardSession, type TerminalReason } from "./card-session.js";
import { ANSWER_ELEMENT_ID, FOOTER_ELEMENT_ID, LOADING_ELEMENT_ID, LOADING_HINT_ELEMENT_ID, PANEL_CONTENT_ELEMENT_ID, PANEL_ELEMENT_ID, addElementsAction, buildCreatingCard, buildFallbackCard, buildFallbackText, buildFooter, buildPanelElement, deleteElementsAction, panelContent, partialUpdateElementAction, type CardRenderOptions } from "./card-renderer.js";
import type { MetricsCollector } from "../monitoring/metrics.js";

export interface StreamingManagerOptions extends CardRenderOptions { flushIntervalMs: number; maxAnswerElementChars: number; }
export interface StaticFallback {
  sendMessage(chatId: string, text: string, replyToMsgId?: string): Promise<void>;
  sendCard?(chatId: string, card: Record<string, unknown>, replyToMsgId?: string): Promise<string | null>;
  updateCard?(messageId: string, card: Record<string, unknown>): Promise<void>;
}

export class StreamingCardManager {
  private active: CardSession | null = null;
  private legacyModeReason = "";
  constructor(private readonly cardkit: CardKitOperations, private readonly fallback: StaticFallback, private readonly options: StreamingManagerOptions, private readonly metrics?: MetricsCollector) {}
  get activeSession(): CardSession | null { return this.active; }
  useLegacyMode(reason: string): void { this.legacyModeReason = reason; }

  async start(chatId: string, userMsgId: string): Promise<CardSession> {
    if (this.active && !this.active.terminal) await this.abort("被新请求取代", "replaced");
    const session = new CardSession(`${Date.now()}-${userMsgId}`, chatId, userMsgId, this.options.flushIntervalMs); this.active = session;
    this.metrics?.setActive(1);
    if (this.legacyModeReason) {
      session.fallbackReason = this.legacyModeReason;
      session.transition("creation_failed", "card_creation_failed", "legacy_transport");
      if (this.fallback.sendCard) session.fallbackCardMessageId = await this.fallback.sendCard(chatId, buildFallbackCard(session, this.options, false), userMsgId);
      return session;
    }
    try { session.cardId = await this.cardkit.createCard(buildCreatingCard(this.options)); this.metrics?.increment("cardsCreated"); session.cardMessageId = await this.cardkit.sendCardReference(chatId, session.cardId, userMsgId); }
    catch (error) {
      session.fallbackReason = error instanceof Error ? error.message : String(error);
      session.transition("creation_failed", "card_creation_failed", "start");
      if (this.fallback.sendCard) {
        try { session.fallbackCardMessageId = await this.fallback.sendCard(chatId, buildFallbackCard(session, this.options, false), userMsgId); }
        catch { session.fallbackCardMessageId = null; }
      }
    }
    return session;
  }

  private accepts(s: CardSession): boolean { return !s.terminal || s.phase === "creation_failed"; }
  onTextDelta(delta: string): void { const s = this.active; if (!s || !this.accepts(s)) return; s.appendText(delta); this.schedule(s); }
  onThinkingDelta(delta: string): void { const s = this.active; if (!s || !this.accepts(s)) return; s.appendThinking(delta); this.schedule(s); }
  onToolStart(id: string, name: string, args: unknown): void { const s = this.active; if (!s || !this.accepts(s)) return; s.recordTool(id); s.tools.start(id, name, args); s.panelDirty = true; this.schedule(s); }
  onToolUpdate(id: string, result: unknown): void { const s = this.active; if (!s || !this.accepts(s)) return; if (s.tools.update(id, result)) s.recordTool(id); s.panelDirty = true; this.schedule(s); }
  onToolEnd(id: string, result: unknown, error: boolean): void { const s = this.active; if (!s || !this.accepts(s)) return; if (s.tools.end(id, result, error)) s.recordTool(id); s.panelDirty = true; this.schedule(s); }
  recordError(message: string): void { const s = this.active; if (!s || !this.accepts(s)) return; s.errorMessage = message; }
  onAgentEnd(): void { this.active?.finishThinking(); }

  async settle(): Promise<CardSession | null> {
    const s = this.active; if (!s) return null; s.finishThinking();
    if (s.phase === "creation_failed") {
      s.resolveCreationFailure(s.errorMessage ? "failed" : "completed", s.errorMessage ? "llm_error" : "normal", "agent_settled_fallback");
      await this.finalize(s); return s;
    }
    if (s.terminal) { await this.finalize(s); return s; }
    s.transition("completing");
    await s.flush.flushNow(() => this.flushSession(s)); await s.updates.drain();
    s.transition(s.errorMessage ? "failed" : "completed", s.errorMessage ? "llm_error" : "normal", "agent_settled");
    await this.finalize(s); return s;
  }

  async abort(message = "用户已停止当前任务", reason: TerminalReason = "user_abort"): Promise<CardSession | null> {
    const s = this.active; if (!s || (s.terminal && s.phase !== "creation_failed")) return s; s.errorMessage = message; s.finishThinking();
    if (s.phase === "creation_failed") s.resolveCreationFailure("aborted", reason, "abort_fallback"); else s.transition("aborted", reason, "abort");
    s.flush.complete(); await s.updates.drain(); await this.finalize(s); return s;
  }
  async terminate(message = "会话已关闭"): Promise<CardSession | null> { const s = this.active; if (!s || (s.terminal && s.phase !== "creation_failed")) return s; s.errorMessage = message; if (s.phase === "creation_failed") s.resolveCreationFailure("terminated", "session_shutdown", "session_shutdown_fallback"); else s.transition("terminated", "session_shutdown", "session_shutdown"); s.flush.complete(); await s.updates.drain(); await this.finalize(s); return s; }
  release(): void { this.active = null; }
  private schedule(s: CardSession): void { s.flush.schedule(() => this.flushSession(s)); }

  private async flushSession(s: CardSession): Promise<void> {
    if (!s.cardId) {
      if (s.fallbackCardMessageId && this.fallback.updateCard && s.phase === "creation_failed") {
        this.metrics?.increment("flushes");
        s.answerDirty = false; s.panelDirty = false;
        try { await this.fallback.updateCard(s.fallbackCardMessageId, buildFallbackCard(s, this.options, false)); }
        catch { s.fallbackCardMessageId = null; }
      }
      return;
    }
    if (s.terminal) return;
    if (s.nativeUpdatesStopped) { await this.patchCompatibilityCard(s, false); return; }
    this.metrics?.increment("flushes");
    const answer = s.answerDirty; const panel = s.panelDirty; s.answerDirty = false; s.panelDirty = false;
    try {
      const initializedNow = await this.ensureStreamingElements(s);
      if (answer) await this.flushAnswer(s);
      if (panel && !initializedNow && !s.nativeUpdatesStopped) await this.flushPanel(s);
    } catch (error) { this.stopNativeUpdates(s, error); await this.patchCompatibilityCard(s, false); }
  }

  private async finalize(s: CardSession): Promise<void> {
    if (s.finalized) return;
    s.finalized = true;
    s.flush.complete();
    if (!s.cardId) {
      this.metrics?.increment("fallbacks");
      if (s.fallbackCardMessageId && this.fallback.updateCard) {
        try { await this.fallback.updateCard(s.fallbackCardMessageId, buildFallbackCard(s, this.options, true)); }
        catch { await this.fallback.sendMessage(s.chatId, buildFallbackText(s, this.options) || "处理结束，但未生成文本回复。", s.userMsgId); }
      } else {
        await this.fallback.sendMessage(s.chatId, buildFallbackText(s, this.options) || "处理结束，但未生成文本回复。", s.userMsgId);
      }
      this.metrics?.setActive(0); return;
    }
    if (s.nativeUpdatesStopped) { await this.sendMissingTail(s); this.metrics?.setActive(0); return; }
    try {
      await this.ensureStreamingElements(s);
      const terminalPanel = buildPanelElement(s, this.options, true) as { header?: unknown; elements?: unknown };
      const terminalActions = [
        partialUpdateElementAction(PANEL_ELEMENT_ID, { header: terminalPanel.header, elements: terminalPanel.elements }),
        addElementsAction([buildFooter(s)], LOADING_ELEMENT_ID),
        deleteElementsAction([LOADING_ELEMENT_ID]),
      ];
      try { await s.updates.enqueue(() => this.cardkit.batchUpdate(s.cardId!, terminalActions, s.nextSequence())); }
      catch (error) {
        if ((error as CardKitError)?.kind !== "element_limit") throw error;
        const minimalPanel = { tag: "collapsible_panel", element_id: PANEL_ELEMENT_ID, expanded: false, header: { title: { tag: "plain_text", content: "Agent loop · 详细步骤已裁剪" } }, elements: [{ tag: "markdown", content: "早期步骤因卡片元素限制已折叠。" }] };
        await s.updates.enqueue(() => this.cardkit.batchUpdate(s.cardId!, [
          partialUpdateElementAction(PANEL_ELEMENT_ID, { header: minimalPanel.header, elements: minimalPanel.elements }),
          addElementsAction([buildFooter(s)], LOADING_ELEMENT_ID),
          deleteElementsAction([LOADING_ELEMENT_ID]),
        ], s.nextSequence()));
      }
      await s.updates.enqueue(() => this.cardkit.updateSettings(s.cardId!, { streaming_mode: false, summary: { content: (s.answer || s.errorMessage || "处理结束").slice(0, 120) } }, s.nextSequence()));
      await s.updates.drain();
      this.metrics?.recordFinalize(); this.metrics?.setActive(0);
    } catch (error) { this.stopNativeUpdates(s, error); await this.sendMissingTail(s); this.metrics?.setActive(0); }
  }
  private describe(error: unknown): string { return (error as CardKitError)?.message ?? String(error); }

  private async flushAnswer(s: CardSession): Promise<void> {
    while (s.answer.length - s.currentCardStart > this.options.maxAnswerElementChars) {
      const remaining = s.answer.slice(s.currentCardStart); const split = splitMarkdown(remaining, this.options.maxAnswerElementChars);
      await this.updateAnswerWithRecovery(s, normalizeMarkdown(split.head), s.currentCardStart + split.consumed);
      await s.updates.enqueue(() => this.cardkit.updateSettings(s.cardId!, { streaming_mode: false, summary: { content: split.head.slice(0, 120) } }, s.nextSequence()));
      s.rolloverCardIds.push(s.cardId!); if (s.cardMessageId) s.rolloverMessageIds.push(s.cardMessageId);
      this.metrics?.increment("rollovers");
      s.currentCardStart += split.consumed; s.epoch++;
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
      if (kind === "element_unavailable" || kind === "streaming_closed") {
        await s.updates.enqueue(() => this.cardkit.batchUpdate(s.cardId!, [partialUpdateElementAction(ANSWER_ELEMENT_ID, { content })], s.nextSequence()));
        if (kind === "streaming_closed") s.streamingAlreadyClosed = true;
      } else throw error;
    }
    s.deliveredAnswerLength = deliveredLength;
  }

  private async flushPanel(s: CardSession): Promise<void> {
    const panel = trimPanelToTagLimit(buildPanelElement(s, this.options), 190);
    try { await s.updates.enqueue(() => this.cardkit.updateElement(s.cardId!, PANEL_CONTENT_ELEMENT_ID, panelContent(panel), s.nextSequence())); }
    catch (error) {
      if ((error as CardKitError)?.kind !== "element_limit") throw error;
      const minimal = { tag: "collapsible_panel", element_id: PANEL_ELEMENT_ID, expanded: false, header: { title: { tag: "plain_text", content: "Agent loop · 早期步骤已裁剪" } }, elements: [{ tag: "markdown", content: "详细步骤因卡片元素限制已折叠。" }] };
      await s.updates.enqueue(() => this.cardkit.batchUpdate(s.cardId!, [partialUpdateElementAction(PANEL_ELEMENT_ID, { header: minimal.header, elements: minimal.elements })], s.nextSequence()));
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
      const minimalPanel = { tag: "collapsible_panel", element_id: PANEL_ELEMENT_ID, expanded: false, header: { title: { tag: "plain_text", content: "Agent loop · 详细步骤已裁剪" } }, elements: [{ tag: "markdown", content: "详细步骤因卡片元素限制已折叠。" }] };
      await s.updates.enqueue(() => this.cardkit.batchUpdate(s.cardId!, [
        addElementsAction([minimalPanel, answerElement], LOADING_HINT_ELEMENT_ID),
        deleteElementsAction([LOADING_HINT_ELEMENT_ID]),
      ], s.nextSequence()));
    }
    s.elementsInitialized = true;
    return true;
  }

  private stopNativeUpdates(s: CardSession, error: unknown): void {
    s.nativeUpdatesStopped = true; const kind = (error as CardKitError)?.kind;
    s.nativeErrorCode = (error as CardKitError)?.code;
    s.nativeErrorKind = kind ?? "unknown";
    this.metrics?.recordError(String((error as CardKitError)?.code ?? kind ?? "unknown"), this.describe(error));
    if (kind === "message_unavailable") { s.transition("terminated", "message_unavailable", "cardkit"); return; }
    const message = this.describe(error);
    s.fallbackReason ||= `CardKit ${s.nativeErrorCode ?? "unknown"}/${s.nativeErrorKind}: ${message}`;
    console.warn(`[pi-feishu] CardKit streaming stopped: code=${s.nativeErrorCode ?? "unknown"} kind=${s.nativeErrorKind} message=${message}`);
  }
  private async patchCompatibilityCard(s: CardSession, terminal: boolean): Promise<boolean> {
    if (!s.cardMessageId || !this.fallback.updateCard) return false;
    try {
      await this.fallback.updateCard(s.cardMessageId, buildFallbackCard(s, this.options, terminal));
      if (terminal) s.fallbackPatched = true;
      return true;
    } catch { return false; }
  }
  private async sendMissingTail(s: CardSession): Promise<void> {
    if (s.terminalReason === "message_unavailable") return;
    if (!s.fallbackPatched) {
      if (await this.patchCompatibilityCard(s, true)) {
        this.metrics?.increment("fallbacks");
        return;
      }
    }
    const tail = s.answer.slice(s.deliveredAnswerLength);
    const diagnostic = s.nativeErrorCode ? `（CardKit ${s.nativeErrorCode}/${s.nativeErrorKind}）` : "";
    if (tail) { this.metrics?.increment("fallbacks"); await this.fallback.sendMessage(s.chatId, `流式更新中断${diagnostic}，以下为剩余内容：\n\n${tail}`, s.userMsgId); }
    else if (!s.answer && s.errorMessage) { this.metrics?.increment("fallbacks"); await this.fallback.sendMessage(s.chatId, `处理失败：${s.errorMessage}`, s.userMsgId); }
  }
}
