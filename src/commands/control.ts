/** 运行控制命令：/stop /queue /compact /model */

import { describeError } from "../log.js";
import {
  buildModelListLines,
  formatModelRef,
  parseModelArg,
  resolveModelFromArg,
} from "../model-registry.js";
import type { CommandHandler } from "./types.js";

export const stopCommand: CommandHandler = {
  name: "/stop",
  help: "中断当前任务并清空队列",
  async handle(ctx) {
    ctx.clearTaskTimeout();
    await ctx.clarify?.abort();

    const streamingHere = ctx.streaming?.activeSession?.chatId === ctx.chatId;
    if (streamingHere) await ctx.streaming!.abort("用户已停止当前任务");

    const clearedCount = ctx.queues.pendingFor(ctx.chatId);
    if (streamingHere) ctx.client?.stopTyping(ctx.chatId, false).catch(() => {});
    ctx.queues.reset(ctx.chatId);

    if (ctx.ctx && !ctx.ctx.isIdle()) {
      ctx.ctx.abort();
      return "已中断当前处理，队列已清空。";
    }
    if (clearedCount > 0) return `已清空 ${clearedCount} 条排队消息。`;
    return "当前没有正在处理的任务。";
  },
};

export const queueCommand: CommandHandler = {
  name: "/queue",
  help: "查看队列状态",
  async handle(ctx) {
    const active = ctx.streaming?.activeSession?.chatId === ctx.chatId;
    const count = ctx.queues.pendingFor(ctx.chatId);
    if (!active && count === 0) return "队列为空，当前空闲。";

    let reply = (ctx.ctx?.isIdle() ?? true) ? "状态: 空闲" : "状态: 处理中";
    if (count > 0) reply += `\n排队中: ${count} 条消息`;
    return reply;
  },
};

export const compactCommand: CommandHandler = {
  name: "/compact",
  help: "压缩上下文",
  async handle(ctx) {
    if (!ctx.ctx) return "无法执行：会话上下文不可用。";

    // compact 是异步的，回调里要用当前 chat/msg 而非后续变化的值
    const { client, chatId, msgId } = ctx;
    ctx.ctx.compact({
      onComplete: () => {
        void client?.sendMessage(chatId, "上下文压缩已完成。", msgId);
      },
      onError: (error) => {
        void client?.sendMessage(chatId, `上下文压缩失败：${describeError(error)}`, msgId);
      },
    });
    return "已触发上下文压缩…";
  },
};

export const modelCommand: CommandHandler = {
  name: "/model",
  help: "查看/切换模型（/model cpa/grok45[:high]）",
  async handle(ctx) {
    if (!ctx.ctx) return "无法切换模型：会话上下文不可用。";

    const registry = ctx.ctx.modelRegistry;
    const current = ctx.ctx.model;

    if (!ctx.args.trim()) {
      const listed = buildModelListLines(registry.getAvailable(), current);
      const header =
        listed.mode === "scoped"
          ? `常用模型 (enabledModels, ${listed.total}):`
          : listed.mode === "providers"
            ? `已配置 provider (${listed.total} 个模型，未设置 enabledModels):`
            : "可用模型:";
      return [
        current
          ? `当前: ${formatModelRef(current)} · thinking ${ctx.pi.getThinkingLevel()}`
          : "当前: （未选择模型）",
        "用法: /model <provider/id[:thinking]>",
        "示例: /model cpa/grok45",
        "      /model cpa/grok45:high",
        "",
        header,
        ...listed.lines,
      ].join("\n");
    }

    const { pattern, thinking: nextThinking } = parseModelArg(ctx.args);
    const resolved = resolveModelFromArg(registry, pattern);
    if ("error" in resolved) return resolved.error;

    if (!(await ctx.pi.setModel(resolved.model))) {
      return `切换失败：${formatModelRef(resolved.model)} 无可用 API key / 鉴权。`;
    }
    if (nextThinking) ctx.pi.setThinkingLevel(nextThinking);

    const busyNote = ctx.ctx.isIdle()
      ? ""
      : "\n（当前任务仍在运行，新模型将从下一轮对话生效）";
    return `已切换模型: ${formatModelRef(resolved.model)} · thinking ${ctx.pi.getThinkingLevel()}${busyNote}`;
  },
};
