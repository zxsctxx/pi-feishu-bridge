/**
 * Pi-Feishu 扩展主入口
 *
 * 使用飞书官方 Bot API（WebSocket 长连接）将飞书作为聊天渠道控制 Pi。
 *
 * 功能：
 * 1. 飞书 WebSocket 入站、消息去重与媒体收发
 * 2. Pi v0.80.6 assistant/thinking delta 单卡流式输出
 * 3. thinking 与工具调用按时间线展示，工具通过 toolCallId 关联
 * 4. 节流刷新、完成/错误/中断封卡与静态消息降级
 * 5. Reaction、聊天队列、/feishu 命令和主动发送工具
 *
 * 消息流程：用户消息 → 占位卡 → delta/工具事件原卡更新 → agent_settled 封卡。
 *
 * 配置优先级（从高到低）：
 *   1. CLI 标志: --feishu-app-id, --feishu-app-secret 等
 *   2. 环境变量: FEISHU_APP_ID, FEISHU_APP_SECRET 等
 *   3. Pi settings.json 中的 feishu 字段
 */

import {
  AgentSession,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import { FeishuClient } from "./feishu-client.js";
import type { FeishuConfig, InboundMessageContext, InboundResource } from "./types.js";
import { accessRiskWarning, evaluateAccess, formatAccessDeniedMessage } from "./access/policy.js";
import { StreamingCardManager } from "./streaming/card-manager.js";
import { MetricsCollector, formatMetrics } from "./monitoring/metrics.js";
import { formatDoctor, runDoctor } from "./monitoring/doctor.js";
import { PRODUCT_ID, PRODUCT_NAME, PRODUCT_VERSION } from "./version.js";
import { ClarifyManager } from "./clarify/manager.js";
import { ConfigReloadCoordinator } from "./monitoring/reload.js";
import { warn, describeError } from "./log.js";
import { loadConfig, validateConfig, formatConfigProblems } from "./config.js";
import { MessageQueueManager, type QueuedMessage } from "./queue.js";
import { accumulateUsage, type MessageUsage, type UsageEntry } from "./session/usage.js";
import {
  dispatchCommand,
  CMD_FEISHU_SESSION_NEW,
  CMD_FEISHU_RUNTIME_RELOAD,
  CMD_FEISHU_SESSION_RESUME,
  INTERNAL_SESSION_COMMANDS,
} from "./commands/index.js";

// ─── 常量 ─────────────────────────────────────────────

/** 工具名到友好名称的映射 */
const TOOL_DISPLAY_NAMES: Record<string, string> = {
  bash: "Shell",
  read: "读取文件",
  edit: "编辑文件",
  write: "写入文件",
  grep: "搜索",
  find: "查找文件",
  ls: "列出目录",
  glob: "匹配文件",
  agent: "子代理",
  send_to_feishu: "发送消息",
  send_image_to_feishu: "发送图片",
  send_file_to_feishu: "发送文件",
};

/** 友好化工具名 */
function toolDisplayName(name: string): string {
  return TOOL_DISPLAY_NAMES[name] ?? name;
}


// ─── 扩展入口 ───────────────────────────────────────────

/** newSession/reload 会拆掉旧扩展实例；用 globalThis 跨实例投递飞书回执 */
type PendingFeishuNotify = { chatId: string; text: string; at: number };
const PENDING_NOTIFY_KEY = "__piFeishuBridgePendingNotify";

function setPendingFeishuNotify(notify: PendingFeishuNotify | null): void {
  (globalThis as Record<string, unknown>)[PENDING_NOTIFY_KEY] = notify;
}

function takePendingFeishuNotify(): PendingFeishuNotify | null {
  const g = globalThis as Record<string, unknown>;
  const notify = (g[PENDING_NOTIFY_KEY] as PendingFeishuNotify | null | undefined) ?? null;
  g[PENDING_NOTIFY_KEY] = null;
  return notify;
}

/** switchSession 路径经 globalThis 传递，避免 Windows 路径空格被斜杠参数拆开 */
const PENDING_RESUME_PATH_KEY = "__piFeishuBridgePendingResumePath";

function setPendingResumePath(path: string | null): void {
  (globalThis as Record<string, unknown>)[PENDING_RESUME_PATH_KEY] = path;
}

function takePendingResumePath(): string | null {
  const g = globalThis as Record<string, unknown>;
  const path = (g[PENDING_RESUME_PATH_KEY] as string | null | undefined) ?? null;
  g[PENDING_RESUME_PATH_KEY] = null;
  return path;
}

/**
 * pi.sendUserMessage 硬编码 expandPromptTemplates:false，不会执行扩展命令。
 * 对白名单内部命令改走 expandPromptTemplates:true，才能拿到 ExtensionCommandContext
 *（newSession/reload 只在该上下文可用）。
 */
function installInternalCommandPromptPatch(): void {
  const g = globalThis as Record<string, unknown>;
  if (g.__piFeishuBridgeCmdPatch) return;
  const proto = AgentSession.prototype as unknown as {
    sendUserMessage: (content: unknown, options?: { deliverAs?: string }) => Promise<void>;
    prompt: (text: string, options?: Record<string, unknown>) => Promise<void>;
  };
  const original = proto.sendUserMessage;
  if (typeof original !== "function" || typeof proto.prompt !== "function") return;
  proto.sendUserMessage = async function patchedSendUserMessage(
    this: typeof proto,
    content: unknown,
    options?: { deliverAs?: string },
  ) {
    let text: string | undefined;
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      text = content
        .filter((part: { type?: string; text?: string }) => part?.type === "text" && typeof part.text === "string")
        .map((part: { text: string }) => part.text)
        .join("\n");
    }
    const trimmed = text?.trim() ?? "";
    if (trimmed.startsWith("/")) {
      const space = trimmed.indexOf(" ");
      const name = space === -1 ? trimmed.slice(1) : trimmed.slice(1, space);
      if (INTERNAL_SESSION_COMMANDS.has(name)) {
        await this.prompt(trimmed, {
          expandPromptTemplates: true,
          streamingBehavior: options?.deliverAs,
          source: "extension",
        });
        return;
      }
    }
    return original.call(this, content, options);
  };
  g.__piFeishuBridgeCmdPatch = true;
}

export default function (pi: ExtensionAPI) {
  installInternalCommandPromptPatch();
  let client: FeishuClient | null = null;
  let config: FeishuConfig = loadConfig();
  let ctxRef: ExtensionContext | null = null;
  let streaming: StreamingCardManager | null = null;
  let latestChatId: string | null = null;
  const metrics = new MetricsCollector();
  let clarify: ClarifyManager | null = null;
  const configReload = new ConfigReloadCoordinator();


  // ─── 消息队列 ──────────────────────────────────────────

  const queues = new MessageQueueManager({
    isAgentIdle: () => ctxRef?.isIdle() ?? true,
  });
  /** 当前任务硬超时定时器（agent_settled / abort 时清理） */
  let taskTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

  function clearTaskTimeout(): void {
    if (taskTimeoutTimer) {
      clearTimeout(taskTimeoutTimer);
      taskTimeoutTimer = null;
    }
  }

  function armTaskTimeout(chatId: string): void {
    clearTaskTimeout();
    const sec = config.taskTimeoutSec ?? 900;
    taskTimeoutTimer = setTimeout(() => {
      void (async () => {
        try {
          warn(`task timeout after ${sec}s chatId=${chatId}`);
          flashStatus(`飞书: ⏰ 任务超时 (${sec}s)`);
          if (streaming?.activeSession?.chatId === chatId) {
            await streaming.abort(`任务超时（${sec}s）`, "timeout");
          }
          if (ctxRef && !ctxRef.isIdle()) ctxRef.abort();
          await client?.stopTyping(chatId, false).catch(() => {});
          // abort 后通常会走 agent_settled；若未 settled 也要放开本 chat 队列
          queues.setProcessing(chatId, false);
          flushAllQueues();
        } catch (err) {
          warn(`task timeout handler failed: ${describeError(err)}`);
        }
      })();
    }, sec * 1000);
    if (typeof taskTimeoutTimer === "object" && taskTimeoutTimer && "unref" in taskTimeoutTimer) {
      (taskTimeoutTimer as NodeJS.Timeout).unref?.();
    }
  }

  /** 入站媒体统一本地路径标签（便于模型/tool 直接读盘） */
  function formatInboundResourceLabel(type: InboundResource["type"], localPath: string, fileName?: string): string {
    const name = fileName || localPath.split(/[\\/]/).pop() || localPath;
    switch (type) {
      case "image":
        return `[image: ${name}]\n[Image: source: ${localPath}]`;
      case "audio":
        return `[audio: ${name}]\n[File: source: ${localPath}]`;
      case "video":
        return `[video: ${name}]\n[File: source: ${localPath}]`;
      default:
        return `[file: ${name}]\n[File: source: ${localPath}]`;
    }
  }

  // ─── 注册 CLI 标志 ────────────────────────────────────

  pi.registerFlag("feishu-app-id", {
    description: "飞书 App ID",
    type: "string",
    default: "",
  });
  pi.registerFlag("feishu-app-secret", {
    description: "飞书 App Secret",
    type: "string",
    default: "",
  });
  pi.registerFlag("feishu-domain", {
    description: "飞书域名 (feishu 或 lark)",
    type: "string",
    default: "",
  });
  pi.registerFlag("feishu-encrypt-key", {
    description: "飞书事件加密密钥（可选）",
    type: "string",
    default: "",
  });
  pi.registerFlag("feishu-verification-token", {
    description: "飞书事件验证令牌（可选）",
    type: "string",
    default: "",
  });

  // ─── 启动飞书客户端 ──────────────────────────────────

  async function startFeishuClient(): Promise<void> {
    if (client) {
      client.disconnect();
      client = null;
    }

    const flagMap: Record<string, string> = {
      appId: "feishu-app-id",
      appSecret: "feishu-app-secret",
      domain: "feishu-domain",
      encryptKey: "feishu-encrypt-key",
      verificationToken: "feishu-verification-token",
    };
    const overrides: Partial<FeishuConfig> = {};
    for (const [key, flag] of Object.entries(flagMap)) {
      const val = pi.getFlag(flag);
      if (val) (overrides as any)[key] = String(val);
    }
    config = { ...config, ...overrides };

    if (!config.appId || !config.appSecret) {
      if (ctxRef?.hasUI) {
        ctxRef.ui.notify("飞书连接失败：缺少 appId/appSecret", "error");
      }
      return;
    }

    client = new FeishuClient(config);
    streaming = new StreamingCardManager(client.createCardKitClient(metrics), client, {
      flushIntervalMs: Math.max(80, config.flushIntervalMs ?? 200),
      showThinking: config.showThinking ?? false,
      printStrategy: config.printStrategy ?? "delay",
      printStep: config.printStep ?? 4,
      panelExpanded: config.panelExpanded ?? false,
      maxToolSteps: config.maxToolSteps ?? 20,
      maxThinkingRounds: config.maxThinkingRounds ?? 20,
      streamingPanelExpanded: config.streamingPanelExpanded ?? false,
      maxAnswerElementChars: Math.max(1000, config.maxAnswerElementChars ?? 30000),
      maxReasoningChars: Math.max(200, config.maxReasoningChars ?? 3500),
      maxToolDetailChars: Math.max(50, config.maxToolDetailChars ?? 500),
      maxToolOutputChars: Math.max(50, config.maxToolOutputChars ?? 800),
      printFrequencyMs: Math.max(20, Math.min(1000, config.printFrequencyMs ?? 70)),
      footer: config.footer,
    }, metrics);
    clarify = new ClarifyManager(client);

    client.setOnMessage((context) => {
      handleFeishuMessage(context);
    });
    client.setOnStatusChange((status) => {
      updateStatus(ctxRef, status);
    });
    client.setOnCardAction((action) => { void clarify?.handleAction(action); });

    try {
      await client.connect();
      const warning = accessRiskWarning(config);
      if (warning) {
        warn(`${warning}`);
        if (ctxRef?.hasUI) ctxRef.ui.notify(warning, "warning");
      }
    } catch (err) {
      if (ctxRef?.hasUI) {
        ctxRef.ui.notify(`飞书连接错误: ${err}`, "error");
      }
    }
  }

  // ─── 处理飞书入站消息 → 排队或直接处理 ────────────────

  async function handleFeishuMessage(context: InboundMessageContext): Promise<void> {
    const decision = evaluateAccess(context, config);
    if (!decision.allowed) {
      warn(
        `[pi-feishu] access denied reason=${decision.reason ?? "unknown"} chatId=${context.chatId} openId=${context.senderOpenId}`,
      );
      await client?.sendMessage(
        context.chatId,
        formatAccessDeniedMessage(context, decision.reason),
        context.messageId,
      );
      return;
    }

    const { chatId, messageId: msgId, text, chatType, resources } = context;
    const content = text.trim();
    if (!content && resources.length === 0) return;

    // ── 拦截斜杠命令 ──
    if (content.startsWith("/")) {
      await handleSlashCommand(chatId, msgId, content);
      return;
    }

    // ── 入队 / 同 chat 打断 ──
    const incoming: QueuedMessage = { msgId, text: content, resources, chatType };
    const outcome = queues.enqueue(
      chatId,
      incoming,
      config.sameChatBusyPolicy ?? "queue",
      streaming?.activeSession?.chatId === chatId,
    );

    if (outcome.action === "interrupted") {
      clearTaskTimeout();
      await clarify?.abort();
      if (streaming?.activeSession?.chatId === chatId) {
        await streaming.abort("被同会话新消息打断", "user_abort");
      }
      if (outcome.agentBusy) ctxRef?.abort();
      client?.stopTyping(chatId, false).catch(() => {});
      await client?.sendMessage(
        chatId,
        outcome.dropped > 0
          ? `已打断上一条任务，并丢弃 ${outcome.dropped} 条排队，开始处理最新消息。`
          : "已打断上一条任务，开始处理最新消息。",
        msgId,
      );
      flashStatus("飞书: ⚡ 打断并切换到新消息");
      // agentBusy 时等 agent_settled 清 processing 并 flush 最新消息
      if (!outcome.agentBusy) await dequeueAndProcess(chatId);
      return;
    }

    if (outcome.action === "queued") {
      await client?.sendMessage(chatId, `已排队 (前面还有 ${outcome.pending - 1} 条)`, msgId);
      flashStatus(`飞书: 📥 排队中 (${outcome.pending})`);
      return;
    }

    await dequeueAndProcess(chatId);
  }

  /** 从队列取出下一条消息并开始处理 */
  async function dequeueAndProcess(chatId: string): Promise<void> {
    const item = queues.dequeue(chatId);
    if (!item) return;

    flashStatus(`飞书: 📩 ${item.text.substring(0, 20)}${item.text.length > 20 ? "..." : ""}`);

    try {
      // 下载入站媒体，并统一为本地路径标签
      const resourceParts: string[] = [];
      for (const res of item.resources) {
        const localPath = await client!.downloadResource(
          item.msgId,
          res.fileKey,
          res.type,
          res.fileName,
        );
        if (localPath) {
          resourceParts.push(formatInboundResourceLabel(res.type, localPath, res.fileName));
        }
      }

      latestChatId = chatId;

      // 添加 Typing Reaction 并创建单张流式卡片
      await client!.startTyping(chatId, item.msgId);
      await streaming?.start(chatId, item.msgId);
      armTaskTimeout(chatId);

      // 发送给 Pi
      const fullContent = [item.text, ...resourceParts].filter(Boolean).join("\n");
      pi.sendUserMessage(fullContent);
    } catch (err) {
      // 媒体下载或投递失败：告知用户而非静默丢弃，并释放队列
      clearTaskTimeout();
      queues.setProcessing(chatId, false);
      warn(`failed to dispatch message chatId=${chatId}: ${describeError(err)}`);
      client?.stopTyping(chatId, false).catch(() => {});
      await client?.sendMessage(chatId, `消息处理失败：${describeError(err)}`, item.msgId)
        .catch(() => {});
      flushAllQueues();
    }
  }

  // ─── 斜杠命令处理 ──────────────────────────────────────

  /** 为 /new /reload /resume 做前置清理：中断流式、清空本聊天队列、abort Agent */
  async function prepareRemoteSessionControl(chatId: string): Promise<void> {
    latestChatId = chatId;
    clearTaskTimeout();
    await clarify?.abort();
    if (streaming?.activeSession) await streaming.abort("会话控制命令中断当前任务");
    client?.stopTyping(chatId, false).catch(() => {});
    queues.reset(chatId);
    if (ctxRef && !ctxRef.isIdle()) ctxRef.abort();
  }

  /**
   * 处理从飞书发来的斜杠命令。
   * 这些命令不会发给 LLM，而是直接在扩展层执行或回复提示。
   */
  async function handleSlashCommand(
    chatId: string,
    msgId: string,
    text: string,
  ): Promise<void> {
    await dispatchCommand(
      {
        pi,
        get client() { return client; },
        get ctx() { return ctxRef; },
        get config() { return config; },
        get streaming() { return streaming; },
        get clarify() { return clarify; },
        metrics,
        configReload,
        queues,
        prepareSessionControl: () => prepareRemoteSessionControl(chatId),
        reloadConfig: async () => { config = loadConfig(); await startFeishuClient(); },
        flashStatus,
        setPendingNotify: (notifyText: string) =>
          setPendingFeishuNotify({ chatId, text: notifyText, at: Date.now() }),
        setPendingResumePath,
        clearTaskTimeout,
      },
      chatId,
      msgId,
      text,
    );
  }

  // ═══════════════════════════════════════════════════════
  //  Pi v0.80.6 事件 → 单卡流式状态
  // ═══════════════════════════════════════════════════════

  pi.on("message_update", (event) => {
    const update = event.assistantMessageEvent;
    if (update.type === "text_delta") {
      streaming?.onTextDelta(update.delta);
      flashStatus("飞书: 正在流式输出");
    } else if (update.type === "thinking_delta") {
      streaming?.onThinkingDelta(update.delta);
    } else if (update.type === "error") {
      streaming?.recordError(update.error.errorMessage ?? "LLM 返回了未知错误");
    }
  });

  /** 与终端 footer 一致：遍历 session 全部 assistant usage 累加；pending 用于 message_end 尚未落盘的当前条 */
  function applySessionFooterUsage(pending?: { usage?: MessageUsage }): void {
    const card = streaming?.activeSession;
    const sm = ctxRef?.sessionManager;
    if (!card || !sm) return;
    const totals = accumulateUsage(sm.getEntries() as UsageEntry[], pending?.usage);
    card.footer.inputTokens = totals.inputTokens;
    card.footer.outputTokens = totals.outputTokens;
    card.footer.reasoningTokens = totals.reasoningTokens;
    card.footer.cacheRead = totals.cacheRead;
    card.footer.cacheWrite = totals.cacheWrite;
    card.footer.cost = totals.cost;
    card.footer.cacheHitPercent = totals.cacheHitPercent;
  }

  pi.on("before_agent_start", () => {
    const session = streaming?.activeSession;
    if (!session) return;
    session.footer.apiCalls = 0;
    // 本轮开始先刷 session 累计（与终端同口径），apiCalls 仅统计本轮
    applySessionFooterUsage();
  });
  pi.on("after_provider_response", () => {
    const session = streaming?.activeSession; if (session) session.footer.apiCalls++;
  });
  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    const session = streaming?.activeSession; if (!session) return;
    const message = event.message;
    session.footer.model = message.responseModel ?? message.model;
    session.footer.stopReason = message.stopReason;
    // message_end 时尚未写入 session 文件，把当前条作为 pending 并入累计
    applySessionFooterUsage({ usage: message.usage });
  });

  pi.on("tool_execution_start", (event) => {
    streaming?.onToolStart(event.toolCallId, event.toolName, event.args);
    flashStatus(`飞书: 🔧 ${toolDisplayName(event.toolName)}...`);
  });

  pi.on("tool_execution_update", (event) => {
    streaming?.onToolUpdate(event.toolCallId, event.partialResult);
  });

  pi.on("tool_execution_end", (event) => {
    streaming?.onToolEnd(event.toolCallId, event.result, event.isError);
  });

  pi.on("agent_end", () => { streaming?.onAgentEnd(); });

  pi.on("agent_settled", async () => {
    clearTaskTimeout();
    const usage = ctxRef?.getContextUsage(); const active = streaming?.activeSession;
    // 落盘后按 session 全量再刷一次，避免 pending 与 getEntries 边界误差
    applySessionFooterUsage();
    if (active && usage) { active.footer.contextTokens = usage.tokens; active.footer.contextWindow = usage.contextWindow; active.footer.contextPercent = usage.percent; }
    const session = await streaming?.settle();
    if (!session) { await configReload.afterSettled(async () => { config = loadConfig(); await startFeishuClient(); }); return; }
    await client?.stopTyping(session.chatId, session.phase === "completed");
    queues.setProcessing(session.chatId, false);
    streaming?.release();
    flushAllQueues();
    flashStatus(session.terminalReason === "timeout" ? "飞书: ⏰ 超时" : "飞书: ✅ 完成");
    await configReload.afterSettled(async () => { config = loadConfig(); await startFeishuClient(); });
  });

  function flushAllQueues(): void {
    if (!client || client.getStatus() !== "connected") return;
    if (ctxRef && !ctxRef.isIdle()) return;
    // 一次只放行一个 chat：Pi 侧同时只能跑一个任务
    const [chatId] = queues.chatsAwaitingFlush();
    if (!chatId) return;
    void dequeueAndProcess(chatId).catch((err) => {
      // dequeueAndProcess 内部已处理业务异常，这里只兜底意外抛出
      queues.setProcessing(chatId, false);
      warn(`flush failed chatId=${chatId}: ${describeError(err)}`);
    });
  }

  pi.on("session_compact", () => { setTimeout(() => flushAllQueues(), 500); });

  // ─── 会话控制命令（供飞书 /new /reload 经 sendUserMessage 触发）──

  pi.registerCommand(CMD_FEISHU_SESSION_NEW, {
    description: "[内部] 飞书远程新建会话",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      try {
        if (!ctx.isIdle()) {
          ctx.abort();
          await ctx.waitForIdle();
        }
        const result = await ctx.newSession();
        if (result.cancelled) {
          // 新会话未建立，旧实例仍存活，直接回执
          const pending = takePendingFeishuNotify();
          if (pending && client) {
            await client.sendMessage(pending.chatId, "新建会话已取消（被扩展拦截）。");
          }
          ctx.ui.notify("飞书远程 /new 已取消", "warning");
          return;
        }
        // 成功后旧运行时已拆掉；成功文案由新实例 session_start 投递 pending notify
      } catch (error) {
        const pending = takePendingFeishuNotify();
        const detail = error instanceof Error ? error.message : String(error);
        if (pending && client) {
          await client.sendMessage(pending.chatId, `新建会话失败：${detail}`);
        }
        ctx.ui.notify(`飞书远程 /new 失败: ${detail}`, "error");
      }
    },
  });

  pi.registerCommand(CMD_FEISHU_SESSION_RESUME, {
    description: "[内部] 飞书远程恢复会话",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const sessionPath = takePendingResumePath();
      if (!sessionPath) {
        const pending = takePendingFeishuNotify();
        if (pending && client) {
          await client.sendMessage(pending.chatId, "恢复会话失败：未指定会话路径。");
        }
        ctx.ui.notify("飞书远程 /resume 缺少路径", "error");
        return;
      }
      try {
        if (!ctx.isIdle()) {
          ctx.abort();
          await ctx.waitForIdle();
        }
        const result = await ctx.switchSession(sessionPath);
        if (result.cancelled) {
          const pending = takePendingFeishuNotify();
          if (pending && client) {
            await client.sendMessage(pending.chatId, "恢复会话已取消（被扩展拦截）。");
          }
          ctx.ui.notify("飞书远程 /resume 已取消", "warning");
          return;
        }
        // 成功后旧运行时已拆掉；成功文案由新实例 session_start 投递 pending notify
      } catch (error) {
        const pending = takePendingFeishuNotify();
        const detail = error instanceof Error ? error.message : String(error);
        if (pending && client) {
          await client.sendMessage(pending.chatId, `恢复会话失败：${detail}`);
        }
        ctx.ui.notify(`飞书远程 /resume 失败: ${detail}`, "error");
      }
    },
  });

  pi.registerCommand(CMD_FEISHU_RUNTIME_RELOAD, {
    description: "[内部] 飞书远程热重载（等同 /reload）",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      try {
        if (!ctx.isIdle()) {
          ctx.abort();
          await ctx.waitForIdle();
        }
        // reload 后旧内存状态失效，成功回执交给新实例 session_start
        await ctx.reload();
        return;
      } catch (error) {
        const pending = takePendingFeishuNotify();
        const detail = error instanceof Error ? error.message : String(error);
        if (pending && client) {
          await client.sendMessage(pending.chatId, `热重载失败：${detail}`);
        }
        ctx.ui.notify(`飞书远程 /reload 失败: ${detail}`, "error");
      }
    },
  });

  // ─── 注册 /feishu 命令 ────────────────────────────────

  pi.registerCommand("feishu", {
    description: "管理飞书 Bot 连接 (start/stop/status/config/help)",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const action = args.trim().toLowerCase() || "status";

      switch (action) {
        case "start":
          await startFeishuClient();
          ctx.ui.notify("飞书客户端已启动", "info");
          break;

        case "stop":
          await clarify?.abort();
          await streaming?.abort("飞书客户端已停止");
          streaming?.release();
          if (client) {
            client.disconnect();
            client = null;
          }
          ctx.ui.notify("飞书客户端已停止", "info");
          break;

        case "status": {
          const status = client?.getStatus() ?? "未启动";
          ctx.ui.notify(
            `${PRODUCT_NAME} ${PRODUCT_VERSION} (${PRODUCT_ID})\n` +
              `飞书 Bot 状态: ${status}\n` +
              `App ID: ${config.appId ? "****" + config.appId.slice(-4) : "未设置"}\n` +
              `Domain: ${config.domain || "feishu"}${accessRiskWarning(config) ? `\n${accessRiskWarning(config)}` : ""}`,
            "info",
          );
          break;
        }

        case "monitor":
          ctx.ui.notify(formatMetrics(metrics.snapshot()), "info");
          break;
        case "monitor reset":
          metrics.reset(); ctx.ui.notify("Pi-Feishu 监控指标已清零", "info");
          break;
        case "doctor":
          { const connected = client?.getStatus() === "connected"; const cardkit = connected ? await client!.checkCardKitAvailability() : null; ctx.ui.notify(formatDoctor(runDoctor(config, connected, cardkit)), "info"); }
          break;
        case "config reload":
          if ((await configReload.request(ctxRef?.isIdle() ?? true, async () => { config = loadConfig(); await startFeishuClient(); })) === "deferred") ctx.ui.notify("Agent 正在运行，配置将在 agent_settled 后重载", "info");
          else ctx.ui.notify("飞书配置已重载", "info");
          break;

        case "config":
          ctx.ui.notify(
            `当前配置:\n` +
              `App ID: ${config.appId ? "****" + config.appId.slice(-4) : "未设置"}\n` +
              `App Secret: ${config.appSecret ? "****" : "未设置"}\n` +
              `Domain: ${config.domain || "feishu"}\n` +
              `Show Thinking: ${config.showThinking ?? false}\n` +
              `Encrypt Key: ${config.encryptKey ? "已设置" : "未设置"}\n` +
              `Verification Token: ${config.verificationToken ? "已设置" : "未设置"}`,
            "info",
          );
          break;

        case "help":
          ctx.ui.notify(
            `/feishu 命令用法:\n` +
              `  /feishu start   - 启动飞书 Bot 连接\n` +
              `  /feishu stop    - 断开飞书 Bot 连接\n` +
              `  /feishu status  - 查看连接状态\n` +
              `  /feishu config  - 查看当前配置\n` +
              `  /feishu config reload - 重载配置\n` +
              `  /feishu monitor [reset] - 查看或清零指标\n` +
              `  /feishu doctor  - 运行配置诊断\n` +
              `  /feishu help    - 显示帮助\n\n` +
              `配置优先级（从高到低）:\n` +
              `  1. CLI 标志: --feishu-app-id, --feishu-app-secret\n` +
              `  2. 环境变量: FEISHU_APP_ID, FEISHU_APP_SECRET\n` +
              `  3. settings.json 中的 feishu 字段`,
            "info",
          );
          break;

        default:
          ctx.ui.notify(`未知命令: ${action}，使用 /feishu help 查看帮助`, "warning");
      }
    },
  });

  // ─── 注册自定义工具 ──────────────────────────────────

  const AskFeishuParams = {
    type: "object" as const,
    properties: {
      question: { type: "string" as const, description: "需要用户澄清的问题" },
      choices: { type: "array" as const, items: { type: "string" as const }, minItems: 1, maxItems: 10 },
      chat_id: { type: "string" as const, description: "目标聊天 ID；留空使用当前聊天" },
      timeout_seconds: { type: "number" as const, description: "等待秒数，默认使用配置值" },
    },
    required: ["question", "choices"],
  };

  pi.registerTool({
    name: "ask_feishu",
    label: "向飞书用户提问",
    description: "通过飞书交互式选择卡片向授权用户澄清问题，并等待其选择。",
    parameters: AskFeishuParams,
    executionMode: "sequential",
    async execute(_toolCallId, params: Static<typeof AskFeishuParams>, signal) {
      const chatId = params.chat_id || streaming?.activeSession?.chatId || latestChatId;
      if (!client || !clarify || !chatId || !params.question || !params.choices?.length) return { content: [{ type: "text" as const, text: "错误: 飞书未连接、没有目标聊天或参数不完整。" }], details: {} as Record<string, unknown> };
      if (config.allowedChatIds?.length && !config.allowedChatIds.includes(chatId)) return { content: [{ type: "text" as const, text: "错误: 目标聊天不在 allowlist 中。" }], details: { chatId } as Record<string, unknown> };
      const timeout = Math.min(3600, Math.max(5, Number(params.timeout_seconds ?? config.clarifyTimeoutSec ?? 300))) * 1000;
      try {
        const choice = await clarify.ask(chatId, params.question, params.choices, config.allowedOpenIds ?? [], timeout, signal);
        return { content: [{ type: "text" as const, text: `用户选择：${choice}` }], details: { choice, chatId } as Record<string, unknown> };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `澄清失败：${describeError(error)}` }], details: { chatId } as Record<string, unknown> };
      }
    },
  });

  // 发送文本消息
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

  pi.registerTool({
    name: "send_to_feishu",
    label: "发送到飞书",
    description: "发送消息到飞书聊天界面。当用户要求通过飞书发送消息时使用。",
    parameters: SendToFeishuParams,
    async execute(
      _toolCallId: string,
      params: Static<typeof SendToFeishuParams>,
      _signal: AbortSignal | undefined,
      _onUpdate: any,
      _ctx: ExtensionContext,
    ) {
      const message = params.message as string;
      const chatId = (params.chat_id as string) || streaming?.activeSession?.chatId || latestChatId;

      if (!client || client.getStatus() !== "connected") {
        return {
          content: [
            { type: "text" as const, text: "错误: 飞书 Bot 未连接。请先运行 /feishu start 启动连接。" },
          ],
          details: {} as Record<string, unknown>,
        };
      }

      if (!chatId) {
        return {
          content: [
            { type: "text" as const, text: "错误: 没有活跃的飞书聊天。请先在飞书中发送一条消息。" },
          ],
          details: {} as Record<string, unknown>,
        };
      }

      await client.sendMessage(chatId, downgradeHeadings(message));
      return {
        content: [{ type: "text" as const, text: `已发送到飞书 [${chatId}]: ${message}` }],
        details: { sent: true, chatId, message } as Record<string, unknown>,
      };
    },
  });

  // 发送图片
  const SendImageToFeishuParams = {
    type: "object" as const,
    properties: {
      file_path: { type: "string" as const, description: "本地图片文件路径" },
      chat_id: {
        type: "string" as const,
        description: "目标聊天 ID，留空则发送到最近活跃的聊天",
      },
    },
    required: ["file_path"],
  };

  pi.registerTool({
    name: "send_image_to_feishu",
    label: "发送图片到飞书",
    description: "将本地图片文件上传到飞书并发送。当需要发送图片到飞书聊天时使用。",
    parameters: SendImageToFeishuParams,
    async execute(
      _toolCallId: string,
      params: Static<typeof SendImageToFeishuParams>,
      _signal: AbortSignal | undefined,
      _onUpdate: any,
      _ctx: ExtensionContext,
    ) {
      const filePath = params.file_path as string;
      const chatId = (params.chat_id as string) || streaming?.activeSession?.chatId || latestChatId;

      if (!client || client.getStatus() !== "connected") {
        return {
          content: [{ type: "text" as const, text: "错误: 飞书 Bot 未连接。" }],
          details: {} as Record<string, unknown>,
        };
      }

      if (!chatId) {
        return {
          content: [{ type: "text" as const, text: "错误: 没有活跃的飞书聊天。" }],
          details: {} as Record<string, unknown>,
        };
      }

      const imageKey = await client.uploadImage(filePath);
      if (!imageKey) {
        return {
          content: [{ type: "text" as const, text: "错误: 图片上传失败。" }],
          details: {} as Record<string, unknown>,
        };
      }

      await client.sendImage(chatId, imageKey);
      return {
        content: [{ type: "text" as const, text: `图片已发送到飞书 [${chatId}]: ${filePath}` }],
        details: { sent: true, chatId, filePath, imageKey } as Record<string, unknown>,
      };
    },
  });

  // 发送文件
  const SendFileToFeishuParams = {
    type: "object" as const,
    properties: {
      file_path: { type: "string" as const, description: "本地文件路径" },
      file_name: { type: "string" as const, description: "文件名" },
      chat_id: {
        type: "string" as const,
        description: "目标聊天 ID，留空则发送到最近活跃的聊天",
      },
    },
    required: ["file_path", "file_name"],
  };

  pi.registerTool({
    name: "send_file_to_feishu",
    label: "发送文件到飞书",
    description: "将本地文件上传到飞书并发送。当需要发送文件到飞书聊天时使用。",
    parameters: SendFileToFeishuParams,
    async execute(
      _toolCallId: string,
      params: Static<typeof SendFileToFeishuParams>,
      _signal: AbortSignal | undefined,
      _onUpdate: any,
      _ctx: ExtensionContext,
    ) {
      const filePath = params.file_path as string;
      const fileName = params.file_name as string;
      const chatId = (params.chat_id as string) || streaming?.activeSession?.chatId || latestChatId;

      if (!client || client.getStatus() !== "connected") {
        return {
          content: [{ type: "text" as const, text: "错误: 飞书 Bot 未连接。" }],
          details: {} as Record<string, unknown>,
        };
      }

      if (!chatId) {
        return {
          content: [{ type: "text" as const, text: "错误: 没有活跃的飞书聊天。" }],
          details: {} as Record<string, unknown>,
        };
      }

      const fileKey = await client.uploadFile(filePath, fileName);
      if (!fileKey) {
        return {
          content: [{ type: "text" as const, text: "错误: 文件上传失败。" }],
          details: {} as Record<string, unknown>,
        };
      }

      await client.sendFile(chatId, fileKey);
      return {
        content: [{ type: "text" as const, text: `文件已发送到飞书 [${chatId}]: ${fileName}` }],
        details: { sent: true, chatId, filePath, fileName, fileKey } as Record<string, unknown>,
      };
    },
  });

  // ─── 会话生命周期 ─────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    ctxRef = ctx;
    updateStatus(ctx, "disconnected");

    try {
      await startFeishuClient();
    } catch (err) {
      if (ctx.hasUI) {
        ctx.ui.notify(`飞书连接失败: ${err}`, "error");
      }
    }

    // newSession/reload 后新实例在此投递跨实例回执
    const pending = takePendingFeishuNotify();
    if (pending && client && client.getStatus() === "connected") {
      // 丢弃过旧请求（例如上次未完成的残留）
      if (Date.now() - pending.at < 120_000) {
        latestChatId = pending.chatId;
        try {
          await client.sendMessage(pending.chatId, pending.text);
        } catch (err) {
          warn(`pending notify failed: ${describeError(err)}`);
        }
      }
    }

    // 启动后刷新积压的队列
    flushAllQueues();
  });

  pi.on("session_shutdown", async () => {
    clearTaskTimeout();
    await clarify?.abort();
    await streaming?.terminate("Pi 会话已关闭");
    if (client) {
      client.disconnect();
      client = null;
    }
    streaming?.release();
    streaming = null;
  });

  // ─── 工具函数 ────────────────────────────────────────

  /**
   * Markdown 标题降级：所有出站文本的标题层级 +2，最小 H6。
   * 规则：只处理行首 # 开头、不在代码块内的标题行。
   *   H1 → H3, H2 → H4, H3 → H5, H4 → H6, H5/H6 → H6
   */
  function downgradeHeadings(text: string): string {
    const lines = text.split("\n");
    const result: string[] = [];
    let inCodeBlock = false;

    for (const line of lines) {
      // 追踪代码块状态
      if (line.startsWith("```")) {
        inCodeBlock = !inCodeBlock;
        result.push(line);
        continue;
      }

      if (inCodeBlock) {
        result.push(line);
        continue;
      }

      // 匹配行首标题：1-6 个 # 后跟空格或行尾
      const match = line.match(/^(#{1,6})\s/);
      if (match) {
        const level = match[1].length;
        const newLevel = Math.min(level + 2, 6);
        result.push("#".repeat(newLevel) + line.slice(level));
      } else {
        result.push(line);
      }
    }

    return result.join("\n");
  }

  /** 状态栏瞬态消息定时器 */
  let statusTimer: ReturnType<typeof setTimeout> | null = null;
  let currentStatusText: string = "";

  function updateStatus(ctx: ExtensionContext | null, status: string): void {
    if (!ctx?.hasUI) return;

    if (statusTimer) {
      clearTimeout(statusTimer);
      statusTimer = null;
    }

    const statusMap: Record<string, string> = {
      connecting: "飞书: 连接中",
      connected: "飞书: 已连接",
      disconnected: "飞书: 未连接",
      error: "飞书: 错误",
    };

    const text = statusMap[status] ?? `飞书: ${status}`;
    if (currentStatusText === text) return;
    currentStatusText = text;
    ctx.ui.setStatus("feishu", text);
  }

  function flashStatus(message: string): void {
    if (!ctxRef?.hasUI) return;
    if (statusTimer) clearTimeout(statusTimer);

    if (currentStatusText === message) return;
    currentStatusText = message;
    ctxRef.ui.setStatus("feishu", message);

    statusTimer = setTimeout(() => {
      statusTimer = null;
      if (client && client.getStatus() === "connected") {
        const text = "飞书: 已连接";
        if (currentStatusText !== text) {
          currentStatusText = text;
          ctxRef?.ui.setStatus("feishu", text);
        }
      }
    }, 3000);
  }

}
