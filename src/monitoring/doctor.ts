import type { FeishuConfig } from "../types.js";
import { DEFAULT_ACCESS_POLICY } from "../access/policy.js";
import { PRODUCT_NAME, PRODUCT_VERSION } from "../version.js";

export interface DoctorFinding { level: "error" | "warning" | "ok"; message: string; }
export function runDoctor(config: FeishuConfig, connected: boolean, cardkitAvailable: boolean | string | null = null): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  if (!config.appId) findings.push({ level: "error", message: "缺少 App ID" });
  if (!config.appSecret) findings.push({ level: "error", message: "缺少 App Secret" });
  const policy = config.accessPolicy ?? DEFAULT_ACCESS_POLICY;
  if (policy === "open") findings.push({ level: "warning", message: "访问策略为 open，任何可访问 Bot 的用户都可能控制当前 Pi 上下文" });
  if (policy === "allowlist" && !(config.allowedChatIds?.length || config.allowedOpenIds?.length)) {
    findings.push({ level: "warning", message: "allowlist 为空，所有消息都会被拒绝；请配置 allowedOpenIds 和/或 allowedChatIds" });
  }
  if (!connected) findings.push({ level: "warning", message: "飞书 WebSocket/CardKit 尚未连接，无法确认真实 API 可用性" });
  else if (cardkitAvailable === false || typeof cardkitAvailable === "string") findings.push({ level: "error", message: `CardKit 探针失败${typeof cardkitAvailable === "string" ? `：${cardkitAvailable}` : ""}` });
  else if (cardkitAvailable === true) findings.push({ level: "ok", message: "CardKit 创建探针通过" });
  if (!findings.some((item) => item.level === "error")) findings.push({ level: "ok", message: "本地配置结构检查通过" });
  return findings;
}
export function formatDoctor(findings: DoctorFinding[]): string { return [`${PRODUCT_NAME} ${PRODUCT_VERSION} Doctor:`, ...findings.map((item) => `- [${item.level.toUpperCase()}] ${item.message}`)].join("\n"); }
