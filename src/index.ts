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

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { FeishuClient } from "./feishu-client.js";
import type { FeishuConfig, InboundMessageContext, InboundResource } from "./types.js";
import { accessRiskWarning, evaluateAccess } from "./access/policy.js";
import { StreamingCardManager } from "./streaming/card-manager.js";
import { MetricsCollector, formatMetrics } from "./monitoring/metrics.js";
import { formatDoctor, runDoctor } from "./monitoring/doctor.js";
import { PRODUCT_ID, PRODUCT_NAME, PRODUCT_VERSION } from "./version.js";
import { ClarifyManager } from "./clarify/manager.js";
import { ConfigReloadCoordinator } from "./monitoring/reload.js";

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

// ─── 从 Pi settings.json 读取 feishu 配置段 ──────────────

function readFeishuFromSettingsFile(filePath: string): Record<string, unknown> {
  try {
    if (!existsSync(filePath)) return {};
    const raw = readFileSync(filePath, "utf-8");
    const json = JSON.parse(raw);
    const fs = json?.feishu;
    if (!fs || typeof fs !== "object") return {};
    return {
      appId: fs.appId ?? fs.app_id ?? "",
      appSecret: fs.appSecret ?? fs.app_secret ?? "",
      domain: fs.domain ?? "",
      encryptKey: fs.encryptKey ?? fs.encrypt_key ?? "",
      verificationToken: fs.verificationToken ?? fs.verification_token ?? "",
      flushIntervalMs: fs.flushIntervalMs ?? fs.flush_interval_ms,
      showThinking: fs.showThinking ?? fs.show_thinking ?? fs.showReasoning ?? fs.show_reasoning,
      printStrategy: fs.printStrategy ?? fs.print_strategy,
      printStep: fs.printStep ?? fs.print_step,
      panelExpanded: fs.panelExpanded ?? fs.panel_expanded,
      maxToolSteps: fs.maxToolSteps ?? fs.max_tool_steps,
      maxThinkingRounds: fs.maxThinkingRounds ?? fs.max_thinking_rounds,
      accessPolicy: fs.accessPolicy ?? fs.access_policy,
      allowedChatIds: fs.allowedChatIds ?? fs.allowed_chat_ids,
      allowedOpenIds: fs.allowedOpenIds ?? fs.allowed_open_ids,
      requireMentionInGroup: fs.requireMentionInGroup ?? fs.require_mention_in_group,
      streamingPanelExpanded: fs.streamingPanelExpanded ?? fs.streaming_panel_expanded,
      maxAnswerElementChars: fs.maxAnswerElementChars ?? fs.max_answer_element_chars,
      clarifyTimeoutSec: fs.clarifyTimeoutSec ?? fs.clarify_timeout_sec,
      monitoringEnabled: fs.monitoringEnabled ?? fs.monitoring_enabled,
      streamingTransport: fs.streamingTransport ?? fs.streaming_transport,
    };
  } catch {
    return {};
  }
}

function loadConfig(): FeishuConfig {
  const globalSettings = readFeishuFromSettingsFile(
    join(homedir(), ".pi", "agent", "settings.json"),
  );
  const projectSettings = readFeishuFromSettingsFile(
    join(process.cwd(), ".pi", "settings.json"),
  );
  const s: Record<string, unknown> = { ...globalSettings, ...projectSettings };
  const stringValue = (value: unknown): string => typeof value === "string" ? value : "";
  const numberValue = (value: unknown, fallback: number): number => {
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const booleanValue = (value: unknown, fallback: boolean): boolean => {
    if (typeof value === "boolean") return value;
    if (value === "true" || value === "1") return true;
    if (value === "false" || value === "0") return false;
    return fallback;
  };
  const stringList = (value: unknown): string[] => {
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && item.length > 0);
    if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
    return [];
  };

  const domain = (process.env.FEISHU_DOMAIN || stringValue(s.domain) || "feishu") as "feishu" | "lark";

  return {
    appId: process.env.FEISHU_APP_ID || stringValue(s.appId),
    appSecret: process.env.FEISHU_APP_SECRET || stringValue(s.appSecret),
    domain,
    encryptKey: process.env.FEISHU_ENCRYPT_KEY || stringValue(s.encryptKey) || undefined,
    verificationToken: process.env.FEISHU_VERIFICATION_TOKEN || stringValue(s.verificationToken) || undefined,
    flushIntervalMs: numberValue(process.env.FEISHU_FLUSH_INTERVAL_MS ?? s.flushIntervalMs, 200),
    showThinking: booleanValue(process.env.FEISHU_SHOW_THINKING ?? process.env.FEISHU_SHOW_REASONING ?? s.showThinking, false),
    printStrategy: (process.env.FEISHU_PRINT_STRATEGY || stringValue(s.printStrategy) || "delay") as "fast" | "delay",
    printStep: numberValue(process.env.FEISHU_PRINT_STEP ?? s.printStep, 4),
    panelExpanded: booleanValue(process.env.FEISHU_PANEL_EXPANDED ?? s.panelExpanded, false),
    maxToolSteps: numberValue(process.env.FEISHU_MAX_TOOL_STEPS ?? s.maxToolSteps, 20),
    maxThinkingRounds: numberValue(process.env.FEISHU_MAX_THINKING_ROUNDS ?? s.maxThinkingRounds, 20),
    accessPolicy: (process.env.FEISHU_ACCESS_POLICY || stringValue(s.accessPolicy) || "open") as "open" | "allowlist",
    allowedChatIds: stringList(process.env.FEISHU_ALLOWED_CHAT_IDS ?? s.allowedChatIds),
    allowedOpenIds: stringList(process.env.FEISHU_ALLOWED_OPEN_IDS ?? s.allowedOpenIds),
    requireMentionInGroup: booleanValue(process.env.FEISHU_REQUIRE_MENTION_IN_GROUP ?? s.requireMentionInGroup, false),
    streamingPanelExpanded: booleanValue(process.env.FEISHU_STREAMING_PANEL_EXPANDED ?? s.streamingPanelExpanded, false),
    maxAnswerElementChars: numberValue(process.env.FEISHU_MAX_ANSWER_ELEMENT_CHARS ?? s.maxAnswerElementChars, 30000),
    clarifyTimeoutSec: numberValue(process.env.FEISHU_CLARIFY_TIMEOUT_SEC ?? s.clarifyTimeoutSec, 300),
    monitoringEnabled: booleanValue(process.env.FEISHU_MONITORING_ENABLED ?? s.monitoringEnabled, true),
    streamingTransport: (process.env.FEISHU_STREAMING_TRANSPORT || stringValue(s.streamingTransport) || "auto") as "auto" | "cardkit" | "im_patch",
  };
}

// ─── 扩展入口 ───────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let client: FeishuClient | null = null;
  let config: FeishuConfig = loadConfig();
  let ctxRef: ExtensionContext | null = null;
  let streaming: StreamingCardManager | null = null;
  let latestChatId: string | null = null;
  const metrics = new MetricsCollector();
  let clarify: ClarifyManager | null = null;
  const configReload = new ConfigReloadCoordinator();


  // ─── 消息队列 ──────────────────────────────────────────

  interface QueuedMessage {
    msgId: string;
    text: string;
    resources: InboundResource[];
    chatType: "p2p" | "group";
  }

  interface ChatQueue {
    processing: boolean;
    queue: QueuedMessage[];
  }

  /** 每个聊天的消息队列 */
  const chatQueues: Map<string, ChatQueue> = new Map();

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
      if (config.streamingTransport === "im_patch") {
        streaming?.useLegacyMode("配置已强制使用 IM PATCH 兼容流式");
      } else if (config.streamingTransport !== "cardkit") {
        const nativeAvailable = await client.checkCardKitAvailability();
        if (!nativeAvailable) {
          streaming?.useLegacyMode("CardKit 原生流式探针未通过，自动使用 IM PATCH 兼容流式");
          console.warn("[pi-feishu] CardKit native streaming probe failed; using IM PATCH transport");
        }
      }
      const warning = accessRiskWarning(config);
      if (warning) {
        console.warn(`[pi-feishu] ${warning}`);
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
      await client?.sendMessage(context.chatId, "无权访问此机器人。", context.messageId);
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

    // ── 入队 ──
    const queue = chatQueues.get(chatId) ?? { processing: false, queue: [] };
    chatQueues.set(chatId, queue);

    queue.queue.push({ msgId, text: content, resources, chatType });

    const anotherRequestIsRunning = [...chatQueues.entries()].some(([id, candidate]) => id !== chatId && candidate.processing);
    if (queue.processing || anotherRequestIsRunning || (ctxRef ? !ctxRef.isIdle() : false)) {
      // 当前正在处理 → 通知排队
      const pos = [...chatQueues.values()].reduce((total, candidate) => total + candidate.queue.length, 0);
      await client?.sendMessage(
        chatId,
        `已排队 (前面还有 ${pos - 1} 条)`,
        msgId,
      );
      flashStatus(`飞书: 📥 排队中 (${pos})`);
      return;
    }

    // 当前空闲 → 开始处理
    await dequeueAndProcess(chatId);
  }

  /** 从队列取出下一条消息并开始处理 */
  async function dequeueAndProcess(chatId: string): Promise<void> {
    const queue = chatQueues.get(chatId);
    if (!queue || queue.queue.length === 0) {
      // 队列空，标记空闲
      if (queue) queue.processing = false;
      return;
    }

    // Pi 正忙（压缩中/流式中）→ 不出队，保持 processing=false 等空闲时再触发
    if (ctxRef && !ctxRef.isIdle()) {
      queue.processing = false;
      return;
    }
    if ([...chatQueues.entries()].some(([id, candidate]) => id !== chatId && candidate.processing)) {
      queue.processing = false;
      return;
    }

    queue.processing = true;
    const item = queue.queue.shift()!;

    flashStatus(`飞书: 📩 ${item.text.substring(0, 20)}${item.text.length > 20 ? "..." : ""}`);

    // 下载入站媒体
    let resourceDescription = "";
    for (const res of item.resources) {
      const localPath = await client!.downloadResource(
        item.msgId,
        res.fileKey,
        res.type,
        res.fileName,
      );
      if (localPath) {
        const typeLabel =
          res.type === "image" ? "图片" :
          res.type === "audio" ? "语音" :
          res.type === "video" ? "视频" : "文件";
        resourceDescription += `\n[收到${typeLabel}: ${localPath}]`;
      }
    }

    latestChatId = chatId;

    // 添加 Typing Reaction 并创建单张流式卡片
    await client!.startTyping(chatId, item.msgId);
    await streaming?.start(chatId, item.msgId);

    // 发送给 Pi
    const fullContent = item.text + (resourceDescription ? "\n" + resourceDescription : "");
    pi.sendUserMessage(fullContent);
  }

  // ─── 斜杠命令处理 ──────────────────────────────────────

  /**
   * 处理从飞书发来的斜杠命令。
   * 这些命令不会发给 LLM，而是直接在扩展层执行或回复提示。
   */
  async function handleSlashCommand(
    chatId: string,
    msgId: string,
    text: string,
  ): Promise<void> {
    const parts = text.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1).join(" ");

    switch (cmd) {
      case "/feishu": {
        const action = args.toLowerCase() || "help";
        if (action === "monitor") await client?.sendMessage(chatId, formatMetrics(metrics.snapshot()), msgId);
        else if (action === "monitor reset") { metrics.reset(); await client?.sendMessage(chatId, "Pi-Feishu 监控指标已清零。", msgId); }
        else if (action === "doctor") { const connected = client?.getStatus() === "connected"; const cardkit = connected ? await client!.checkCardKitAvailability() : null; await client?.sendMessage(chatId, formatDoctor(runDoctor(config, connected, cardkit)), msgId); }
        else if (action === "status") {
          const warning = accessRiskWarning(config);
          await client?.sendMessage(chatId, `${PRODUCT_NAME} ${PRODUCT_VERSION} (${PRODUCT_ID})\n飞书连接: ${client?.getStatus() ?? "未启动"}\n访问策略: ${config.accessPolicy ?? "open"}${warning ? `\n${warning}` : ""}`, msgId);
        } else if (action === "config") {
          await client?.sendMessage(chatId, `Domain: ${config.domain ?? "feishu"}\nStreaming transport: ${config.streamingTransport ?? "auto"}\nShow thinking: ${config.showThinking ?? false}\nAccess policy: ${config.accessPolicy ?? "open"}\nAllowed chats: ${config.allowedChatIds?.length ?? 0}\nAllowed users: ${config.allowedOpenIds?.length ?? 0}`, msgId);
        } else if (action === "config reload") {
          const result = await configReload.request(ctxRef?.isIdle() ?? true, async () => { config = loadConfig(); await startFeishuClient(); });
          await client?.sendMessage(chatId, result === "deferred" ? "配置将在当前 Agent 完全 settled 后重载。" : "配置已重载。", msgId);
        } else {
          await client?.sendMessage(chatId, "/feishu status | monitor [reset] | config [reload] | doctor | help", msgId);
        }
        break;
      }
      case "/new": {
        await client?.sendMessage(chatId, "飞书远程 /new 无法通过 Pi 公开扩展 API 创建真正的新会话。请在 Pi TUI 中执行 /new；如只需压缩上下文，请使用 /compact。", msgId);
        break;
      }

      case "/stop": {
        await clarify?.abort();
        if (streaming?.activeSession?.chatId === chatId) await streaming.abort("用户已停止当前任务");
        // 中断当前处理 + 清空队列
        const queue = chatQueues.get(chatId);
        const clearedCount = queue?.queue.length ?? 0;

        if (streaming?.activeSession?.chatId === chatId) client?.stopTyping(chatId, false).catch(() => {});
        if (queue) {
          queue.queue = [];
          queue.processing = false;
        }

        if (ctxRef && !ctxRef.isIdle()) {
          ctxRef.abort();
          await client?.sendMessage(chatId, "已中断当前处理，队列已清空。", msgId);
        } else if (clearedCount > 0) {
          await client?.sendMessage(chatId, `已清空 ${clearedCount} 条排队消息。`, msgId);
        } else {
          await client?.sendMessage(chatId, "当前没有正在处理的任务。", msgId);
        }
        break;
      }

      case "/queue": {
        const queue = chatQueues.get(chatId);
        const state = streaming?.activeSession?.chatId === chatId ? streaming.activeSession : null;
        const count = queue?.queue.length ?? 0;
        const idle = ctxRef?.isIdle() ?? true;

        if (!state && count === 0) {
          await client?.sendMessage(chatId, "队列为空，当前空闲。", msgId);
        } else {
          let reply = idle ? "状态: 空闲" : "状态: 处理中";
          if (count > 0) {
            reply += `\n排队中: ${count} 条消息`;
          }
          await client?.sendMessage(chatId, reply, msgId);
        }
        break;
      }

      case "/compact": {
        if (ctxRef) {
          ctxRef.compact();
          await client?.sendMessage(chatId, "已触发上下文压缩。", msgId);
        } else {
          await client?.sendMessage(chatId, "无法执行：会话上下文不可用。", msgId);
        }
        break;
      }

      case "/status": {
        const status = client?.getStatus() ?? "未启动";
        const ctxUsage = ctxRef?.getContextUsage();
        const queue = chatQueues.get(chatId);
        let reply = `Pi 状态:\n- 飞书连接: ${status}\n- App ID: ${config.appId ? "****" + config.appId.slice(-4) : "未设置"}`;
        const warning = accessRiskWarning(config); if (warning) reply += `\n- ${warning}`;
        if (ctxUsage && ctxUsage.tokens !== null) {
          reply += `\n- 上下文: ${ctxUsage.tokens}/${ctxUsage.contextWindow} tokens (${ctxUsage.percent ?? "?"}%)`;
        }
        if (queue && queue.queue.length > 0) {
          reply += `\n- 排队: ${queue.queue.length} 条`;
        }
        await client?.sendMessage(chatId, reply, msgId);
        break;
      }

      case "/help": {
        const helpText = [
          "可用命令:",
          "  /new       - 提示在 Pi TUI 中创建真正的新会话",
          "  /stop      - 中断当前处理，清空排队",
          "  /queue     - 查看排队状态",
          "  /compact   - 压缩上下文",
          "  /status    - 查看 Pi 状态",
          "  /help      - 显示帮助",
          "",
          "以下命令请在 Pi 终端中执行:",
          "  /model     - 切换模型",
          "  /tools     - 管理工具",
        ].join("\n");
        await client?.sendMessage(chatId, helpText, msgId);
        break;
      }

      default: {
        await client?.sendMessage(
          chatId,
          `命令 ${cmd} 不支持通过飞书执行。请在 Pi 终端中使用。`,
          msgId,
        );
        break;
      }
    }
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

  pi.on("before_agent_start", () => {
    const session = streaming?.activeSession; if (session) session.footer = { apiCalls: 0 };
  });
  pi.on("after_provider_response", () => {
    const session = streaming?.activeSession; if (session) session.footer.apiCalls++;
  });
  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    const session = streaming?.activeSession; if (!session) return;
    const message = event.message;
    session.footer.model = message.responseModel ?? message.model;
    session.footer.inputTokens = message.usage.input; session.footer.outputTokens = message.usage.output; session.footer.reasoningTokens = message.usage.reasoning;
    session.footer.cacheRead = message.usage.cacheRead; session.footer.cacheWrite = message.usage.cacheWrite; session.footer.cost = message.usage.cost.total; session.footer.stopReason = message.stopReason;
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
    const usage = ctxRef?.getContextUsage(); const active = streaming?.activeSession;
    if (active && usage) { active.footer.contextTokens = usage.tokens; active.footer.contextWindow = usage.contextWindow; active.footer.contextPercent = usage.percent; }
    const session = await streaming?.settle();
    if (!session) { await configReload.afterSettled(async () => { config = loadConfig(); await startFeishuClient(); }); return; }
    await client?.stopTyping(session.chatId, session.phase === "completed");
    const queue = chatQueues.get(session.chatId);
    if (queue) queue.processing = false;
    streaming?.release();
    flushAllQueues();
    flashStatus("飞书: ✅ 完成");
    await configReload.afterSettled(async () => { config = loadConfig(); await startFeishuClient(); });
  });

  function flushAllQueues(): void {
    if (!client || client.getStatus() !== "connected") return;
    if (ctxRef && !ctxRef.isIdle()) return;
    for (const [chatId, queue] of chatQueues) {
      if (!queue.processing && queue.queue.length > 0) {
        void dequeueAndProcess(chatId).catch(() => { queue.processing = false; });
        break;
      }
    }
  }

  pi.on("session_compact", () => { setTimeout(() => flushAllQueues(), 500); });

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
              `Streaming Transport: ${config.streamingTransport ?? "auto"}\n` +
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
        return { content: [{ type: "text" as const, text: `澄清失败：${error instanceof Error ? error.message : String(error)}` }], details: { chatId } as Record<string, unknown> };
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

    // 启动后刷新积压的队列
    flushAllQueues();
  });

  pi.on("session_shutdown", async () => {
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
