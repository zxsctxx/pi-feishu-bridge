/** 状态查询命令：/status /session /name /feishu /help */

import { accessRiskWarning, DEFAULT_ACCESS_POLICY } from "../access/policy.js";
import { formatMetrics } from "../monitoring/metrics.js";
import { formatDoctor, runDoctor } from "../monitoring/doctor.js";
import { PRODUCT_ID, PRODUCT_NAME, PRODUCT_VERSION } from "../version.js";
import {
  aggregateSessionStats,
  formatNameResult,
  formatSessionMeta,
  formatStatusSessionLines,
} from "../session/meta.js";
import { formatModelRef } from "../model-registry.js";
import type { CommandContext, CommandHandler } from "./types.js";

/** /status 与 /session 共用的会话元信息 */
function sessionMeta(ctx: CommandContext) {
  const session = ctx.ctx!;
  const sm = session.sessionManager;
  const usage = session.getContextUsage();
  return {
    name: ctx.pi.getSessionName() ?? sm.getSessionName(),
    sessionId: sm.getSessionId(),
    sessionFile: sm.getSessionFile(),
    cwd: session.cwd || sm.getCwd() || undefined,
    ...aggregateSessionStats(sm.getEntries() as Parameters<typeof aggregateSessionStats>[0]),
    context: usage
      ? { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent }
      : undefined,
    modelLine: session.model
      ? `${formatModelRef(session.model)} · thinking ${ctx.pi.getThinkingLevel()}`
      : undefined,
  };
}

export const statusCommand: CommandHandler = {
  name: "/status",
  help: "查看 Pi 状态",
  async handle(ctx) {
    const pending = ctx.queues.pendingFor(ctx.chatId);
    const appId = ctx.config.appId ? `****${ctx.config.appId.slice(-4)}` : "未设置";
    let reply = `Pi 状态:\n- 飞书连接: ${ctx.client?.getStatus() ?? "未启动"}\n- App ID: ${appId}`;

    const warning = accessRiskWarning(ctx.config);
    if (warning) reply += `\n- ${warning}`;

    if (pending > 0) reply += `\n- 排队: ${pending} 条`;
    else if (ctx.ctx && !ctx.ctx.isIdle()) reply += "\n- 状态: 处理中";
    else reply += "\n- 状态: 空闲";

    if (ctx.ctx) {
      reply += `\n${formatStatusSessionLines(sessionMeta(ctx)).join("\n")}`;
    }
    return reply;
  },
};

export const sessionCommand: CommandHandler = {
  name: "/session",
  help: "查看会话元信息（ID/文件/消息数/token/费用）",
  async handle(ctx) {
    if (!ctx.ctx) return "无法查看：会话上下文不可用。";
    return formatSessionMeta(sessionMeta(ctx));
  },
};

export const nameCommand: CommandHandler = {
  name: "/name",
  help: "查看/设置会话名称（/name · /name 任务A · /name clear）",
  async handle(ctx) {
    const raw = ctx.args.trim();
    if (!raw) return formatNameResult(ctx.pi.getSessionName(), "show");
    if (raw.toLowerCase() === "clear" || raw === "-") {
      ctx.pi.setSessionName("");
      return formatNameResult(undefined, "cleared");
    }
    ctx.pi.setSessionName(raw);
    return formatNameResult(raw, "set");
  },
};

const FEISHU_USAGE = "/feishu status | monitor [reset] | config [reload] | doctor | help";

export const feishuCommand: CommandHandler = {
  name: "/feishu",
  help: FEISHU_USAGE,
  async handle(ctx) {
    switch (ctx.args.toLowerCase() || "help") {
      case "monitor":
        return formatMetrics(ctx.metrics.snapshot());

      case "monitor reset":
        ctx.metrics.reset();
        return "Pi-Feishu 监控指标已清零。";

      case "doctor": {
        const connected = ctx.client?.getStatus() === "connected";
        const cardkit = connected ? await ctx.client!.checkCardKitAvailability() : null;
        return formatDoctor(runDoctor(ctx.config, connected, cardkit));
      }

      case "status": {
        const warning = accessRiskWarning(ctx.config);
        return (
          `${PRODUCT_NAME} ${PRODUCT_VERSION} (${PRODUCT_ID})\n` +
          `飞书连接: ${ctx.client?.getStatus() ?? "未启动"}\n` +
          `访问策略: ${ctx.config.accessPolicy ?? DEFAULT_ACCESS_POLICY}` +
          (warning ? `\n${warning}` : "")
        );
      }

      case "config":
        return [
          `Domain: ${ctx.config.domain ?? "feishu"}`,
          `Show thinking: ${ctx.config.showThinking ?? false}`,
          `Task timeout: ${ctx.config.taskTimeoutSec ?? 900}s`,
          `Same-chat busy: ${ctx.config.sameChatBusyPolicy ?? "queue"}`,
          `Access policy: ${ctx.config.accessPolicy ?? DEFAULT_ACCESS_POLICY}`,
          `Allowed chats: ${ctx.config.allowedChatIds?.length ?? 0}`,
          `Allowed users: ${ctx.config.allowedOpenIds?.length ?? 0}`,
        ].join("\n");

      case "config reload": {
        const result = await ctx.configReload.request(
          ctx.ctx?.isIdle() ?? true,
          () => ctx.reloadConfig(),
        );
        return result === "deferred"
          ? "配置将在当前 Agent 完全 settled 后重载。"
          : "配置已重载。";
      }

      default:
        return FEISHU_USAGE;
    }
  },
};

export const helpCommand: CommandHandler = {
  name: "/help",
  help: "显示帮助",
  async handle() {
    return [
      "可用命令:",
      "  /new       - 新建 Pi 会话（清空上下文）",
      "  /resume    - 列出/恢复历史会话（/resume · /resume 3 · /resume all）",
      "  /name      - 查看/设置会话名称（/name · /name 任务A · /name clear）",
      "  /session   - 查看会话元信息（ID/文件/消息数/token/费用）",
      "  /reload    - 热重载扩展/技能/主题等（等同终端 /reload）",
      "  /stop      - 中断当前处理，清空排队",
      "  /queue     - 查看排队状态",
      "  /compact   - 压缩上下文",
      "  /model     - 查看/切换模型（如 /model cpa/grok45）",
      "  /status    - 查看 Pi 状态",
      "  /help      - 显示帮助",
      "",
      "飞书扩展:",
      `  ${FEISHU_USAGE}`,
      "",
      "以下命令请在 Pi 终端中执行:",
      "  /tools     - 管理工具",
    ].join("\n");
  },
};
