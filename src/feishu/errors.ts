export type CardKitErrorKind =
  | "feature_unavailable"
  | "element_limit"
  | "streaming_closed"
  | "element_unavailable"
  | "message_unavailable"
  | "card_id_invalid"
  | "transient"
  | "schema"
  | "unknown";

export class CardKitError extends Error {
  constructor(readonly code: number | undefined, readonly kind: CardKitErrorKind, message: string, readonly cause?: unknown, readonly operation?: string) {
    super(message);
    this.name = "CardKitError";
  }
}

export function errorCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidates = [(error as any).code, (error as any).response?.data?.code, (error as any).response?.status];
  for (const value of candidates) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function errorMessageOf(error: unknown): string {
  if (error instanceof CardKitError) return error.message;
  if (!error || typeof error !== "object") return error instanceof Error ? error.message : String(error);
  const rawMessage = (error as any).msg ?? (error as any).response?.data?.msg;
  if (typeof rawMessage === "string") return rawMessage;
  const responseBody = (error as any).response?.data;
  if (responseBody && typeof responseBody === "object") return JSON.stringify(responseBody);
  return error instanceof Error ? error.message : String(error);
}

/** create 成功后 reply 引用卡时常见：230099 + ErrCode 11310 + cardid is invalid */
export function isCardIdInvalidError(error: unknown): boolean {
  if (error instanceof CardKitError && error.kind === "card_id_invalid") return true;
  const message = errorMessageOf(error);
  // 仅认明确的 id 无效文案；11310 还用于 table/element limit，不可单靠子码判断
  return /cardid is invalid|card_id is invalid/i.test(message);
}

export function classifyCardKitError(error: unknown): CardKitError {
  if (error instanceof CardKitError) return error;
  const code = errorCode(error);
  const message = errorMessageOf(error);
  if (isCardIdInvalidError(error)) {
    return new CardKitError(code ?? 230099, "card_id_invalid", message, error);
  }
  if (code === 11311) return new CardKitError(code, "schema", message, error);
  if (code === 300305) return new CardKitError(code, "element_limit", message, error);
  if (code === 300309) return new CardKitError(code, "streaming_closed", message, error);
  if (code === 300313) return new CardKitError(code, "element_unavailable", message, error);
  if (code === 230011 || code === 231003) return new CardKitError(code, "message_unavailable", message, error);
  if (code === 429 || (code !== undefined && code >= 500 && code < 600)) return new CardKitError(code, "transient", message, error);
  if (code !== undefined && code >= 400 && code < 500) return new CardKitError(code, "schema", message, error);
  return new CardKitError(code, "unknown", message, error);
}
