import type { FeishuConfig, InboundMessageContext } from "../types.js";

export interface AccessDecision {
  allowed: boolean;
  reason?: "chat_not_allowed" | "user_not_allowed" | "mention_required" | "empty_allowlist";
}

export function evaluateAccess(
  context: InboundMessageContext,
  config: Pick<FeishuConfig, "accessPolicy" | "allowedChatIds" | "allowedOpenIds" | "requireMentionInGroup">,
): AccessDecision {
  if (context.chatType === "group" && config.requireMentionInGroup && !context.mentionedBot) {
    return { allowed: false, reason: "mention_required" };
  }
  if ((config.accessPolicy ?? "open") === "open") return { allowed: true };

  const chats = config.allowedChatIds ?? [];
  const users = config.allowedOpenIds ?? [];
  if (chats.length === 0 && users.length === 0) return { allowed: false, reason: "empty_allowlist" };
  if (chats.length > 0 && !chats.includes(context.chatId)) return { allowed: false, reason: "chat_not_allowed" };
  if (users.length > 0 && !users.includes(context.senderOpenId)) return { allowed: false, reason: "user_not_allowed" };
  return { allowed: true };
}

export function accessRiskWarning(config: Pick<FeishuConfig, "accessPolicy">): string | null {
  return (config.accessPolicy ?? "open") === "open"
    ? "安全警告：当前为 open 访问模式，任何能访问 Bot 的用户都可能控制此 Pi 会话。"
    : null;
}
