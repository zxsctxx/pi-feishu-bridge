import type { FeishuConfig, InboundMessageContext } from "../types.js";

export type AccessDenyReason =
  | "chat_not_allowed"
  | "user_not_allowed"
  | "mention_required"
  | "empty_allowlist";

export interface AccessDecision {
  allowed: boolean;
  reason?: AccessDenyReason;
}

/** 默认 allowlist：未配置名单时拒绝所有人，避免误开成公网入口 */
export const DEFAULT_ACCESS_POLICY: "open" | "allowlist" = "allowlist";

export function evaluateAccess(
  context: InboundMessageContext,
  config: Pick<FeishuConfig, "accessPolicy" | "allowedChatIds" | "allowedOpenIds" | "requireMentionInGroup">,
): AccessDecision {
  if (context.chatType === "group" && config.requireMentionInGroup && !context.mentionedBot) {
    return { allowed: false, reason: "mention_required" };
  }
  if ((config.accessPolicy ?? DEFAULT_ACCESS_POLICY) === "open") return { allowed: true };

  const chats = config.allowedChatIds ?? [];
  const users = config.allowedOpenIds ?? [];
  if (chats.length === 0 && users.length === 0) return { allowed: false, reason: "empty_allowlist" };
  if (chats.length > 0 && !chats.includes(context.chatId)) return { allowed: false, reason: "chat_not_allowed" };
  if (users.length > 0 && !users.includes(context.senderOpenId)) return { allowed: false, reason: "user_not_allowed" };
  return { allowed: true };
}

export function accessRiskWarning(config: Pick<FeishuConfig, "accessPolicy">): string | null {
  return (config.accessPolicy ?? DEFAULT_ACCESS_POLICY) === "open"
    ? "安全警告：当前为 open 访问模式，任何能访问 Bot 的用户都可能控制此 Pi 会话。"
    : null;
}

/** 拒绝时给管理员可复制的自身 ID（不含他人信息），便于写入 allowlist */
export function formatAccessDeniedMessage(
  context: Pick<InboundMessageContext, "chatId" | "senderOpenId" | "chatType">,
  reason?: AccessDenyReason,
): string {
  if (reason === "mention_required") {
    return "群聊中请 @机器人 后再发送（已开启 requireMentionInGroup）。";
  }
  const lines = [
    "无权访问此机器人（accessPolicy=allowlist）。",
    "若你是管理员，把下面 ID 写入 ~/.pi/agent/settings.json 的 feishu 段后执行 /feishu config reload：",
    '  "accessPolicy": "allowlist",',
    `  "allowedOpenIds": ["${context.senderOpenId}"],`,
    `  "allowedChatIds": ["${context.chatId}"],`,
    "只配 openIds 表示该用户任意会话可聊；只配 chatIds 表示该会话任意用户可聊；两者都配则需同时匹配。",
  ];
  if (reason === "empty_allowlist") {
    lines.splice(1, 0, "当前 allowlist 为空，所有人都会被拒绝。");
  }
  if (context.chatType === "group") {
    lines.push("群聊还需注意 requireMentionInGroup。");
  }
  return lines.join("\n");
}
