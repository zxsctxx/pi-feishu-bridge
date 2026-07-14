/**
 * Pi-Feishu 类型定义
 *
 * 使用飞书官方 Bot API（WebSocket 长连接 + REST API）
 */

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
  clarifyTimeoutSec?: number;
  monitoringEnabled?: boolean;
  streamingTransport?: "auto" | "cardkit" | "im_patch";
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
  clarifyTimeoutSec?: number;
  monitoringEnabled?: boolean;
  streamingTransport?: "auto" | "cardkit" | "im_patch";
}
