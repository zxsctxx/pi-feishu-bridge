/**
 * 会话生命周期命令：/new /resume /reload。
 *
 * 这三个都要拆掉当前扩展实例，因此走「前置清理 → 记录跨实例回执 →
 * 经 followUp 触发内部命令」的统一流程。
 */

import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  formatResumeList,
  resolveSessionFromArg,
  sessionDisplayTitle,
  type ResumeSessionInfo,
} from "../session/resume.js";
import { describeError } from "../log.js";
import type { CommandContext, CommandHandler } from "./types.js";

/** 内部命令名：仅供飞书斜杠经 sendUserMessage 触发，勿与内置 /new /reload /resume 抢名 */
export const CMD_FEISHU_SESSION_NEW = "feishu-session-new";
export const CMD_FEISHU_RUNTIME_RELOAD = "feishu-runtime-reload";
export const CMD_FEISHU_SESSION_RESUME = "feishu-session-resume";

export const INTERNAL_SESSION_COMMANDS = new Set([
  CMD_FEISHU_SESSION_NEW,
  CMD_FEISHU_RUNTIME_RELOAD,
  CMD_FEISHU_SESSION_RESUME,
]);

export const newCommand: CommandHandler = {
  name: "/new",
  help: "新建会话（清空上下文）",
  async handle(ctx) {
    await ctx.prepareSessionControl();
    ctx.setPendingNotify("已新建会话。先前上下文已清空，可继续对话。");
    await ctx.client?.sendMessage(ctx.chatId, "正在新建会话…", ctx.msgId);
    // newSession 仅在命令上下文可用；经 followUp 触发内部命令
    ctx.pi.sendUserMessage(`/${CMD_FEISHU_SESSION_NEW}`, { deliverAs: "followUp" });
  },
};

export const reloadCommand: CommandHandler = {
  name: "/reload",
  help: "热重载扩展/技能/主题（仅重载飞书配置用 /feishu config reload）",
  async handle(ctx) {
    await ctx.prepareSessionControl();
    ctx.setPendingNotify(
      "已热重载扩展、技能、提示词、主题与上下文文件；飞书连接已恢复。\n（仅重载飞书配置请用 /feishu config reload）",
    );
    await ctx.client?.sendMessage(ctx.chatId, "正在热重载…", ctx.msgId);
    ctx.pi.sendUserMessage(`/${CMD_FEISHU_RUNTIME_RELOAD}`, { deliverAs: "followUp" });
  },
};

export const resumeCommand: CommandHandler = {
  name: "/resume",
  help: "列出/恢复历史会话（/resume · /resume 3 · /resume <id|名称> · /resume all）",
  async handle(ctx: CommandContext): Promise<string | void> {
    const arg = ctx.args.trim();
    const listAll = arg.toLowerCase() === "all";
    const cwd = ctx.ctx?.cwd;
    const currentId = ctx.ctx?.sessionManager?.getSessionId?.() ?? null;

    const loadSessions = async (all: boolean): Promise<ResumeSessionInfo[]> =>
      all || !cwd ? SessionManager.listAll() : SessionManager.list(cwd);

    let sessions: ResumeSessionInfo[];
    try {
      sessions = await loadSessions(listAll);
    } catch (error) {
      return `列出会话失败：${describeError(error)}`;
    }

    const scopeNote = listAll
      ? "范围: 全部工作目录"
      : cwd
        ? "范围: 当前工作目录"
        : undefined;

    // 无参数或 all → 仅列表
    if (!arg || listAll) {
      return formatResumeList(sessions, { currentId, scopeNote });
    }

    let resolved = resolveSessionFromArg(sessions, arg);
    // 非编号在本 cwd 未命中时回退全库（编号始终对应当前列表）
    if (!resolved.ok && !/^\d+$/.test(arg) && cwd) {
      try {
        sessions = await loadSessions(true);
        resolved = resolveSessionFromArg(sessions, arg);
      } catch {
        // 保留首次错误
      }
    }
    if (!resolved.ok) return resolved.error;

    if (currentId && resolved.session.id === currentId) {
      return `已在该会话中：${sessionDisplayTitle(resolved.session)}`;
    }

    const title = sessionDisplayTitle(resolved.session);
    await ctx.prepareSessionControl();
    ctx.setPendingResumePath(resolved.session.path);
    ctx.setPendingNotify(`已恢复会话：${title}\n（${resolved.session.messageCount} 条消息）`);
    await ctx.client?.sendMessage(ctx.chatId, `正在恢复会话：${title}…`, ctx.msgId);
    ctx.pi.sendUserMessage(`/${CMD_FEISHU_SESSION_RESUME}`, { deliverAs: "followUp" });
  },
};
