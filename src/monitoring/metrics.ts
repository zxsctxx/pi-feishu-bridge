import { PRODUCT_NAME, PRODUCT_VERSION } from "../version.js";

export interface MonitoringSnapshot { cardsCreated: number; cardkitApiCalls: number; flushes: number; retries: number; fallbacks: number; rollovers: number; activeSessions: number; errors: Record<string, number>; lastError: string | null; lastSuccessfulFinalizeAt: number | null; }

export class MetricsCollector {
  private data: MonitoringSnapshot = { cardsCreated: 0, cardkitApiCalls: 0, flushes: 0, retries: 0, fallbacks: 0, rollovers: 0, activeSessions: 0, errors: {}, lastError: null, lastSuccessfulFinalizeAt: null };
  increment(field: "cardsCreated" | "cardkitApiCalls" | "flushes" | "retries" | "fallbacks" | "rollovers", amount = 1): void { this.data[field] += amount; }
  setActive(value: number): void { this.data.activeSessions = value; }
  recordError(code: string, message: string): void { this.data.errors[code] = (this.data.errors[code] ?? 0) + 1; this.data.lastError = message; }
  recordFinalize(): void { this.data.lastSuccessfulFinalizeAt = Date.now(); }
  snapshot(): MonitoringSnapshot { return structuredClone(this.data); }
  reset(): void { const active = this.data.activeSessions; this.data = { cardsCreated: 0, cardkitApiCalls: 0, flushes: 0, retries: 0, fallbacks: 0, rollovers: 0, activeSessions: active, errors: {}, lastError: null, lastSuccessfulFinalizeAt: null }; }
}

export function formatMetrics(snapshot: MonitoringSnapshot): string {
  return [`${PRODUCT_NAME} ${PRODUCT_VERSION} 监控:`, `- 活跃 session: ${snapshot.activeSessions}`, `- 创建卡片: ${snapshot.cardsCreated}`, `- CardKit API: ${snapshot.cardkitApiCalls}`, `- flush: ${snapshot.flushes}`, `- retry: ${snapshot.retries}`, `- fallback: ${snapshot.fallbacks}`, `- rollover: ${snapshot.rollovers}`, `- 错误: ${JSON.stringify(snapshot.errors)}`, `- 最近错误: ${snapshot.lastError ?? "无"}`].join("\n");
}
