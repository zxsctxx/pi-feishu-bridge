/**
 * Pi-Feishu 类型定义
 *
 * 使用飞书官方 Bot API（WebSocket 长连接 + REST API）
 */

/** 页脚可配置字段（与终端语义对齐） */
export type FooterFieldId =
  | "status"
  | "elapsed"
  | "model"
  | "api_calls"
  | "tokens"
  | "context"
  | "cache"
  | "error"
  | "cost"
  | "stop_reason";

/**
 * 页脚布局配置。
 * `lines` 为二维数组：外层 = 行，内层 = 同行字段（用 ` · ` 连接）。
 * 默认：
 *   [[status, elapsed, model, api_calls], [tokens, context, cache, error]]
 */
export interface FooterConfig {
  showFooter?: boolean;
  lines?: FooterFieldId[][];
}

/** 飞书客户端配置 */
export interface FeishuConfig {
  /** 飞书 App ID */
  appId: string;
  /** 飞书 App Secret */
  appSecret: string;
  /** 域名：feishu（国内）或 lark（海外），默认 feishu */
  domain?: "feishu" | "lark";
  /** 事件加密密钥（可选） */
  encryptKey?: string;
  /** 事件验证令牌（可选） */
  verificationToken?: string;
  flushIntervalMs?: number;
  showThinking?: boolean;
  printStrategy?: "fast" | "delay";
  printStep?: number;
  panelExpanded?: boolean;
  maxToolSteps?: number;
  maxThinkingRounds?: number;
  accessPolicy?: "open" | "allowlist";
  allowedChatIds?: string[];
  allowedOpenIds?: string[];
  requireMentionInGroup?: boolean;
  streamingPanelExpanded?: boolean;
  maxAnswerElementChars?: number;
  /** 单轮推理正文展示上限，默认 3500 */
  maxReasoningChars?: number;
  /** 工具 detail 展示/存储上限，默认 500 */
  maxToolDetailChars?: number;
  /** 工具 output 展示/存储上限，默认 800 */
  maxToolOutputChars?: number;
  /** CardKit 流式 print_frequency_ms，默认 70 */
  printFrequencyMs?: number;
  clarifyTimeoutSec?: number;
  monitoringEnabled?: boolean;
  streamingTransport?: "auto" | "cardkit" | "im_patch";
  /** 卡片页脚配置；未配置时使用默认两行布局 */
  footer?: FooterConfig;
}

export interface InboundResource {
  type: "image" | "file" | "audio" | "video";
  fileKey: string;
  fileName?: string;
}

export interface InboundMessageContext {
  chatId: string;
  messageId: string;
  senderOpenId: string;
  chatType: "p2p" | "group";
  mentionedBot: boolean;
  text: string;
  resources: InboundResource[];
}

/** 桥接服务状态 */
export type BridgeStatus = "disconnected" | "connecting" | "connected" | "error";

/** settings.json 中 feishu 配置段 */
export interface FeishuSettingsSection {
  appId?: string;
  appSecret?: string;
  domain?: string;
  encryptKey?: string;
  verificationToken?: string;
  flushIntervalMs?: number;
  showThinking?: boolean;
  printStrategy?: "fast" | "delay";
  printStep?: number;
  panelExpanded?: boolean;
  maxToolSteps?: number;
  maxThinkingRounds?: number;
  accessPolicy?: "open" | "allowlist";
  allowedChatIds?: string[];
  allowedOpenIds?: string[];
  requireMentionInGroup?: boolean;
  streamingPanelExpanded?: boolean;
  maxAnswerElementChars?: number;
  maxReasoningChars?: number;
  maxToolDetailChars?: number;
  maxToolOutputChars?: number;
  printFrequencyMs?: number;
  clarifyTimeoutSec?: number;
  monitoringEnabled?: boolean;
  streamingTransport?: "auto" | "cardkit" | "im_patch";
  footer?: FooterConfig;
}
