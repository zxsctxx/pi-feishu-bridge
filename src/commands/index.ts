/**
 * 飞书斜杠命令的表驱动路由。
 *
 * handler 返回字符串即由此处统一回复，避免每个命令重复写 sendMessage。
 */

import { warn, describeError } from "../log.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { newCommand, reloadCommand, resumeCommand } from "./session.js";
import { compactCommand, modelCommand, queueCommand, stopCommand } from "./control.js";
import {
  feishuCommand,
  helpCommand,
  nameCommand,
  sessionCommand,
  statusCommand,
} from "./status.js";

export * from "./types.js";
export {
  CMD_FEISHU_SESSION_NEW,
  CMD_FEISHU_RUNTIME_RELOAD,
  CMD_FEISHU_SESSION_RESUME,
  INTERNAL_SESSION_COMMANDS,
} from "./session.js";

const HANDLERS: CommandHandler[] = [
  feishuCommand,
  newCommand,
  resumeCommand,
  reloadCommand,
  stopCommand,
  queueCommand,
  compactCommand,
  modelCommand,
  statusCommand,
  nameCommand,
  sessionCommand,
  helpCommand,
];

const REGISTRY = new Map(HANDLERS.map((handler) => [handler.name, handler]));

export interface CommandDeps extends Omit<CommandContext, "chatId" | "msgId" | "args"> {}

/**
 * 解析并执行一条飞书斜杠命令。
 *
 * `/feishu config reload` 这类带空格的子命令由 handler 自行解析 args。
 */
export async function dispatchCommand(
  deps: CommandDeps,
  chatId: string,
  msgId: string,
  text: string,
): Promise<void> {
  const parts = text.trim().split(/\s+/);
  const name = parts[0].toLowerCase();
  const args = parts.slice(1).join(" ");

  const handler = REGISTRY.get(name);
  if (!handler) {
    await deps.client?.sendMessage(
      chatId,
      `命令 ${name} 不支持通过飞书执行。请在 Pi 终端中使用。`,
      msgId,
    );
    return;
  }

  const ctx: CommandContext = { ...deps, chatId, msgId, args };
  try {
    const reply = await handler.handle(ctx);
    if (typeof reply === "string" && reply) {
      await deps.client?.sendMessage(chatId, reply, msgId);
    }
  } catch (error) {
    warn(`command ${name} failed: ${describeError(error)}`);
    await deps.client
      ?.sendMessage(chatId, `命令执行失败：${describeError(error)}`, msgId)
      .catch(() => {});
  }
}
