import { createHash } from "node:crypto";
import { CardKitError, classifyCardKitError } from "./errors.js";
import { UnavailableMessageGuard } from "./unavailable-guard.js";
import type { MetricsCollector } from "../monitoring/metrics.js";

export interface CardKitOperations {
  createCard(card: Record<string, unknown>): Promise<string>;
  sendCardReference(chatId: string, cardId: string, replyToMessageId?: string): Promise<string>;
  updateElement(cardId: string, elementId: string, content: string, sequence: number): Promise<void>;
  batchUpdate(cardId: string, actions: unknown[], sequence: number): Promise<void>;
  updateSettings(cardId: string, settings: Record<string, unknown>, sequence: number): Promise<void>;
}

type RawClient = any;

export class FeishuCardKitClient implements CardKitOperations {
  readonly unavailable = new UnavailableMessageGuard();
  constructor(private readonly client: RawClient, private readonly wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)), private readonly metrics?: MetricsCollector) {}

  async createCard(card: Record<string, unknown>): Promise<string> {
    const response = await this.call(() => this.client.cardkit.v1.card.create({ data: { type: "card_json", data: JSON.stringify(card) } }), "create", "new", 0);
    const cardId = response?.data?.card_id;
    if (!cardId) throw new CardKitError(response?.code, "schema", "CardKit create response did not contain card_id");
    return cardId;
  }

  async sendCardReference(chatId: string, cardId: string, replyToMessageId?: string): Promise<string> {
    if (replyToMessageId && this.unavailable.has(replyToMessageId)) throw new CardKitError(230011, "message_unavailable", "Source message is unavailable");
    const content = JSON.stringify({ type: "card", data: { card_id: cardId } });
    try {
      this.metrics?.increment("cardkitApiCalls");
      const response = replyToMessageId
        ? await this.client.im.message.reply({ path: { message_id: replyToMessageId }, data: { msg_type: "interactive", content } })
        : await this.client.im.message.create({ params: { receive_id_type: "chat_id" }, data: { receive_id: chatId, msg_type: "interactive", content } });
      const messageId = response?.data?.message_id;
      if (!messageId) throw new CardKitError(response?.code, "schema", "Card reference response did not contain message_id");
      return messageId;
    } catch (error) {
      const classified = classifyCardKitError(error);
      if (replyToMessageId && classified.kind === "message_unavailable") this.unavailable.mark(replyToMessageId);
      throw classified;
    }
  }

  async updateElement(cardId: string, elementId: string, content: string, sequence: number): Promise<void> {
    await this.call(() => this.client.cardkit.v1.cardElement.content({ path: { card_id: cardId, element_id: elementId }, data: { content, sequence, uuid: this.uuid(cardId, "content", sequence) } }), "content", cardId, sequence, true);
  }

  async batchUpdate(cardId: string, actions: unknown[], sequence: number): Promise<void> {
    await this.call(() => this.client.cardkit.v1.card.batchUpdate({ path: { card_id: cardId }, data: { actions: JSON.stringify(actions), sequence, uuid: this.uuid(cardId, "batch", sequence) } }), "batch", cardId, sequence);
  }

  async updateSettings(cardId: string, settings: Record<string, unknown>, sequence: number): Promise<void> {
    await this.call(() => this.client.cardkit.v1.card.settings({ path: { card_id: cardId }, data: { settings: JSON.stringify({ config: settings }), sequence, uuid: this.uuid(cardId, "settings", sequence) } }), "settings", cardId, sequence);
  }

  private uuid(cardId: string, operation: string, sequence: number): string {
    return createHash("sha256").update(`${cardId}:${operation}:${sequence}`).digest("hex").slice(0, 32);
  }

  private async call(operation: () => Promise<any>, name: string, _cardId: string, _sequence: number, retryElement = false): Promise<any> {
    const delays = [200, 500, 1000];
    let attempts = 0;
    while (true) {
      try {
        this.metrics?.increment("cardkitApiCalls");
        const response = await operation();
        if (response?.code && response.code !== 0) throw response;
        return response;
      } catch (error) {
        const classified = classifyCardKitError(error);
        const retryable = classified.kind === "transient" || (retryElement && classified.kind === "element_unavailable");
        if (!retryable || attempts >= delays.length) {
          const detailed = new CardKitError(classified.code, classified.kind, `${name}: ${classified.message}`, classified.cause ?? error, name);
          this.metrics?.recordError(String(detailed.code ?? detailed.kind), detailed.message); throw detailed;
        }
        this.metrics?.increment("retries");
        await this.wait(delays[attempts++]);
      }
    }
  }
}
