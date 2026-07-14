export type CardKitErrorKind = "feature_unavailable" | "element_limit" | "streaming_closed" | "element_unavailable" | "message_unavailable" | "transient" | "schema" | "unknown";

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

export function classifyCardKitError(error: unknown): CardKitError {
  const code = errorCode(error);
  const rawMessage = error && typeof error === "object"
    ? ((error as any).msg ?? (error as any).response?.data?.msg)
    : undefined;
  const responseBody = error && typeof error === "object" ? (error as any).response?.data : undefined;
  const message = typeof rawMessage === "string"
    ? rawMessage
    : responseBody && typeof responseBody === "object"
      ? JSON.stringify(responseBody)
      : error instanceof Error ? error.message : String(error);
  if (code === 11311) return new CardKitError(code, "schema", message, error);
  if (code === 300305) return new CardKitError(code, "element_limit", message, error);
  if (code === 300309) return new CardKitError(code, "streaming_closed", message, error);
  if (code === 300313) return new CardKitError(code, "element_unavailable", message, error);
  if (code === 230011 || code === 231003) return new CardKitError(code, "message_unavailable", message, error);
  if (code === 429 || (code !== undefined && code >= 500)) return new CardKitError(code, "transient", message, error);
  if (code !== undefined && code >= 400 && code < 500) return new CardKitError(code, "schema", message, error);
  return new CardKitError(code, "unknown", message, error);
}
