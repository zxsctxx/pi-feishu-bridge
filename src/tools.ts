/**
 * 暴露给 LLM 的飞书工具。
 *
 * 目标 chat 的解析顺序：显式参数 → 当前流式会话 → 最近活跃聊天。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import type { FeishuClient } from "./feishu-client.js";
import type { FeishuConfig } from "./types.js";
import type { StreamingCardManager } from "./streaming/card-manager.js";
import type { ClarifyManager, ClarifyOption } from "./clarify/manager.js";
import { describeError } from "./log.js";

/** 通过 getter 读取扩展的可变状态，避免注册时快照 */
export interface ToolDeps {
  readonly client: FeishuClient | null;
  readonly config: FeishuConfig;
  readonly streaming: StreamingCardManager | null;
  readonly clarify: ClarifyManager | null;
  readonly latestChatId: string | null;
  /** 卡片正文里降一级标题，避免飞书渲染出过大的字号 */
  downgradeHeadings(text: string): string;
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
};

function result(text: string, details: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: "text" as const, text }], details };
}

/** 解析目标 chat，并确认连接可用；返回字符串以外的值表示失败 */
function resolveTarget(
  deps: ToolDeps,
  explicitChatId?: string,
): { chatId: string } | { error: ToolResult } {
  if (!deps.client || deps.client.getStatus() !== "connected") {
    return { error: result("错误: 飞书 Bot 未连接。") };
  }
  const chatId = explicitChatId || deps.streaming?.activeSession?.chatId || deps.latestChatId;
  if (!chatId) {
    return { error: result("错误: 没有活跃的飞书聊天。请先在飞书中发送一条消息。") };
  }
  return { chatId };
}

const AskFeishuParams = {
  type: "object" as const,
  properties: {
    question: { type: "string" as const, description: "需要用户澄清的问题" },
    choices: {
      type: "array" as const,
      items: { type: "string" as const },
      minItems: 1,
      maxItems: 10,
      description: "选项列表（纯文本，兼容旧用法；有 options 时忽略）",
    },
    options: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          value: { type: "string" as const, description: "选中后返回的值" },
          label: { type: "string" as const, description: "按钮显示文本" },
          description: { type: "string" as const, description: "可选描述，显示在按钮下方" },
        },
        required: ["value", "label"],
      },
      minItems: 1,
      maxItems: 10,
      description: "结构化选项（类似 questionnaire：value/label/description）；存在时优先于 choices",
    },
    chat_id: { type: "string" as const, description: "目标聊天 ID；留空使用当前聊天" },
    timeout_seconds: { type: "number" as const, description: "等待秒数，默认使用配置值" },
  },
  required: ["question"],
};

/** 归一化选项：options 优先，否则 choices 纯字符串转为 {value,label} */
function normalizeOptions(params: Static<typeof AskFeishuParams>): ClarifyOption[] {  if (params.options?.length) {
    return params.options.map((o) => {
      const option: ClarifyOption = { value: o.value!, label: o.label! };
      if (o.description) option.description = o.description;
      return option;
    });
  }
  return (params.choices ?? []).map((c) => ({ value: c, label: c }));
}

const SendToFeishuParams = {
  type: "object" as const,
  properties: {
    message: { type: "string" as const, description: "要发送的消息内容" },
    chat_id: {
      type: "string" as const,
      description: "目标聊天 ID（飞书 chat_id），留空则发送到最近活跃的聊天",
    },
  },
  required: ["message"],
};

const SendImageToFeishuParams = {
  type: "object" as const,
  properties: {
    file_path: { type: "string" as const, description: "本地图片文件路径" },
    chat_id: { type: "string" as const, description: "目标聊天 ID，留空则发送到最近活跃的聊天" },
  },
  required: ["file_path"],
};

const SendFileToFeishuParams = {
  type: "object" as const,
  properties: {
    file_path: { type: "string" as const, description: "本地文件路径" },
    file_name: { type: "string" as const, description: "文件名" },
    chat_id: { type: "string" as const, description: "目标聊天 ID，留空则发送到最近活跃的聊天" },
  },
  required: ["file_path", "file_name"],
};

export function registerTools(pi: ExtensionAPI, deps: ToolDeps): void {
  pi.registerTool({
    name: "ask_feishu",
    label: "向飞书用户提问",
    description:
      "通过飞书交互式选择卡片向授权用户澄清问题，并等待其选择。仅当对话通过飞书远程进行时使用（向飞书用户提问）；在本机 TUI 终端会话中请改用 questionnaire 工具。",
    parameters: AskFeishuParams,
    executionMode: "sequential",
    async execute(_toolCallId, params: Static<typeof AskFeishuParams>, signal) {
      const target = resolveTarget(deps, params.chat_id);
      if ("error" in target) return target.error;
      const { chatId } = target;

      if (!deps.clarify || !params.question) {
        return result("错误: 澄清管理器不可用或参数不完整。");
      }
      const options = normalizeOptions(params);
      if (!options.length) {
        return result("错误: 澄清管理器不可用或参数不完整。");
      }
      // 澄清卡会等待用户操作，必须遵守 allowlist
      if (deps.config.allowedChatIds?.length && !deps.config.allowedChatIds.includes(chatId)) {
        return result("错误: 目标聊天不在 allowlist 中。", { chatId });
      }

      const timeout =
        Math.min(3600, Math.max(5, Number(params.timeout_seconds ?? deps.config.clarifyTimeoutSec ?? 300))) * 1000;
      try {
        const choice = await deps.clarify.ask(
          chatId,
          params.question,
          options,
          deps.config.allowedOpenIds ?? [],
          timeout,
          signal,
        );
        return result(`用户选择：${choice}`, { choice, chatId });
      } catch (error) {
        return result(`澄清失败：${describeError(error)}`, { chatId });
      }
    },
  });

  pi.registerTool({
    name: "send_to_feishu",
    label: "发送到飞书",
    description: "发送消息到飞书聊天界面。当用户要求通过飞书发送消息时使用。",
    parameters: SendToFeishuParams,
    async execute(
      _toolCallId: string,
      params: Static<typeof SendToFeishuParams>,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: ExtensionContext,
    ) {
      const target = resolveTarget(deps, params.chat_id as string);
      if ("error" in target) return target.error;

      const message = params.message as string;
      await deps.client!.sendMessage(target.chatId, deps.downgradeHeadings(message));
      return result(`已发送到飞书 [${target.chatId}]: ${message}`, {
        sent: true,
        chatId: target.chatId,
        message,
      });
    },
  });

  pi.registerTool({
    name: "send_image_to_feishu",
    label: "发送图片到飞书",
    description: "将本地图片文件上传到飞书并发送。当需要发送图片到飞书聊天时使用。",
    parameters: SendImageToFeishuParams,
    async execute(
      _toolCallId: string,
      params: Static<typeof SendImageToFeishuParams>,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: ExtensionContext,
    ) {
      const target = resolveTarget(deps, params.chat_id as string);
      if ("error" in target) return target.error;

      const filePath = params.file_path as string;
      const imageKey = await deps.client!.uploadImage(filePath);
      if (!imageKey) return result("错误: 图片上传失败。");

      await deps.client!.sendImage(target.chatId, imageKey);
      return result(`图片已发送到飞书 [${target.chatId}]: ${filePath}`, {
        sent: true,
        chatId: target.chatId,
        filePath,
        imageKey,
      });
    },
  });

  pi.registerTool({
    name: "send_file_to_feishu",
    label: "发送文件到飞书",
    description: "将本地文件上传到飞书并发送。当需要发送文件到飞书聊天时使用。",
    parameters: SendFileToFeishuParams,
    async execute(
      _toolCallId: string,
      params: Static<typeof SendFileToFeishuParams>,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: ExtensionContext,
    ) {
      const target = resolveTarget(deps, params.chat_id as string);
      if ("error" in target) return target.error;

      const filePath = params.file_path as string;
      const fileName = params.file_name as string;
      const fileKey = await deps.client!.uploadFile(filePath, fileName);
      if (!fileKey) return result("错误: 文件上传失败。");

      await deps.client!.sendFile(target.chatId, fileKey);
      return result(`文件已发送到飞书 [${target.chatId}]: ${fileName}`, {
        sent: true,
        chatId: target.chatId,
        filePath,
        fileName,
        fileKey,
      });
    },
  });
}
